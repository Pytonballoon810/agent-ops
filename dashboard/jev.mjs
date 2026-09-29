/*
 * The evaluator. Reads Claude Code's own session transcripts and works out what
 * the jev-skill-suggestion mod actually did: which listings it withheld, which
 * skills it injected, what that cost in prefix tokens, and whether the twelve
 * skills Claude invokes itself are reachable at all.
 *
 * Node stdlib only, so it runs under Task Scheduler with nothing installed.
 *
 * Parsing is incremental. A session file grows to tens of megabytes and the
 * biggest one is re-read on every tick otherwise; per-file results are cached
 * on (size, mtimeMs) and only changed files are re-parsed. The cache lives
 * beside this file so a restart does not start from cold.
 *
 * PROVENANCE, which matters when reading the dashboard:
 *   measured  — character counts, turn counts, call counts, timestamps
 *   reported  — cache_read / cache_creation / output token counts (the API's)
 *   estimated — every "token" figure derived from characters, at 4 chars/token
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.USERPROFILE || os.homedir();
export const PATHS = {
  projects: path.join(HOME, '.claude', 'projects'),
  settings: path.join(HOME, '.claude', 'settings.json'),
  cache: path.join(import.meta.dirname, 'data', 'cache.json'),
  snapshot: path.join(import.meta.dirname, 'data', 'snapshot.json'),
};

/** The mod reached user scope here; sessions before it ran without it. */
const MOD_LIVE_FROM = Date.parse('2026-09-22T02:20:00Z');
/** Characters per token. A rule of thumb, not a tokeniser — hence "estimated". */
const CHARS_PER_TOKEN = 4;
const est = (chars) => Math.round(chars / CHARS_PER_TOKEN);

// ---------------------------------------------------------------------------
// One session file
// ---------------------------------------------------------------------------

/**
 * Everything worth knowing about a single transcript. Returns null for a file
 * with no timestamped entries, or one that predates the mod.
 */
function readSession(file, stat) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const entries = [];
  let i = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    i++;
    try {
      const e = JSON.parse(line);
      e._i = i;
      entries.push(e);
    } catch {
      /* a half-written last line while a session is live */
    }
  }
  const stamps = entries.map((e) => e.timestamp).filter(Boolean);
  if (!stamps.length) return null;
  const start = Date.parse(stamps[0]);
  if (!(start >= MOD_LIVE_FROM)) return null;

  const isSubagent = file.includes(`${path.sep}subagents${path.sep}`);
  const END = entries.length + 1;

  // Compaction drops the earlier prefix, so an injection stops being charged
  // there. Without this bound every long session's cost is overstated.
  const compactions = entries
    .filter((e) => e.isCompactSummary || (e.type === 'system' && e.subtype === 'compact_boundary'))
    .map((e) => e._i)
    .sort((a, b) => a - b);

  const turnAt = [];
  for (const e of entries) if (e.type === 'assistant' && e.message?.usage) turnAt.push(e._i);
  const turnsBetween = (from, to) => turnAt.filter((n) => n >= from && n < to).length;

  const s = {
    id: path.basename(file, '.jsonl'),
    project: path.basename(path.dirname(file)).replace(/^C--Users-[^-]+-/, ''),
    file,
    isSubagent,
    start: stamps[0],
    end: stamps[stamps.length - 1],
    entries: entries.length,
    turns: turnAt.length,
    prompts: 0,
    notifications: 0,
    slashCommands: 0,
    compactions: compactions.length,
    usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    listings: [],
    picks: [],
    skillCalls: [],
    refusals: [],
  };

  for (const e of entries) {
    const content = e.message?.content;

    if (e.type === 'user' && typeof content === 'string' && !e.isMeta) {
      if (content.includes('<task-notification>')) s.notifications++;
      else if (content.startsWith('<command-message>') || content.startsWith('<command-name>')) s.slashCommands++;
      else s.prompts++;
    }

    const u = e.message?.usage;
    if (u) {
      s.usage.cacheRead += u.cache_read_input_tokens || 0;
      s.usage.cacheWrite += u.cache_creation_input_tokens || 0;
      s.usage.input += u.input_tokens || 0;
      s.usage.output += u.output_tokens || 0;
    }

    // What the engine rendered. In a main session the mod answers this with
    // nothing, so its size is what never reached the model; a subagent's is
    // left alone by design, so it is a cost the mod does not touch.
    //
    // A session renders this more than once — a resume re-renders it, and a
    // settings change produces a delta with the new roster. Each one is valued
    // from its own position forward, exactly as an injection is, because a
    // listing rendered at turn 600 was never in the prefix for turns 1-599.
    // Summing all of them against the session's whole turn count (which an
    // earlier hand-run of this did) overstates the saving roughly twofold.
    if (e.attachment?.type === 'skill_listing') {
      const chars = (e.attachment.content || '').length;
      const stop = compactions.find((c) => c > e._i) ?? END;
      const rode = turnsBetween(e._i, stop);
      s.listings.push({
        ts: e.timestamp,
        initial: e.attachment.isInitial !== false,
        skillCount: e.attachment.skillCount ?? null,
        chars,
        tokens: est(chars),
        rodeTurns: rode,
        prefixValue: isSubagent ? 0 : est(chars) * rode,
        names: e.attachment.names || [],
      });
    }

    // What the mod attached in the listing's place.
    if (e.attachment?.hookName === 'prompt.submit') {
      const raw = Array.isArray(e.attachment.content)
        ? e.attachment.content.join('')
        : String(e.attachment.content || '');
      if (raw.includes('skill_relevance')) {
        const skill = (raw.match(/Relevant to the current request: ([^.]+)\./) || [, '?'])[1];
        const whole = raw.includes('<skill name=');
        // The injected block names the directory the body came from. That is
        // the only evidence on disk that user-level skills are being found at
        // all — the mod builds those paths from HOME, which Windows leaves
        // unset, and without it a user skill is suggested by name alone.
        const dir = (raw.match(/<skill name="[^"]*" dir="([^"]*)"/) || [, null])[1];
        const stop = compactions.find((c) => c > e._i) ?? END;
        const rode = turnsBetween(e._i, stop);
        s.picks.push({
          ts: e.timestamp,
          skill,
          whole,
          dir,
          repeat: /already loaded above/.test(raw),
          chars: raw.length,
          tokens: est(raw.length),
          rodeTurns: rode,
          prefixCost: est(raw.length) * rode,
          prompt: nearestPrompt(entries, e._i),
        });
      }
    }

    for (const c of content || []) {
      if (c.type === 'tool_use' && c.name === 'Skill' && c.input?.skill) {
        s.skillCalls.push({ ts: e.timestamp, skill: c.input.skill });
      }
      if (c.type === 'tool_result') {
        const body = JSON.stringify(c.content || '');
        if (/disabled for model invocation|Unknown skill/.test(body)) {
          s.refusals.push({ ts: e.timestamp, message: body.slice(1, 160) });
        }
      }
    }
  }

  s.injectionCost = s.picks.reduce((a, p) => a + p.prefixCost, 0);
  s.listingValue = s.listings.reduce((a, l) => a + l.prefixValue, 0);
  // Sessions are gathered by start time, so "the mod was loaded" is an
  // assumption for every one of them. A prompt.submit attachment is the only
  // thing in a transcript that the mod definitely produced; without one, the
  // session's listing may never have been withheld and its value here is an
  // upper bound. Three post-install sessions have none, one of them remote.
  s.modObserved = s.picks.length > 0;
  s.mtimeMs = stat.mtimeMs;
  s.size = stat.size;
  return s;
}

/** The plain user prompt a hook attachment belongs to, trimmed for display. */
function nearestPrompt(entries, index) {
  for (let j = index - 1; j >= 0 && j > index - 40; j--) {
    const e = entries[j - 1];
    if (e && e.type === 'user' && typeof e.message?.content === 'string' && !e.isMeta) {
      return e.message.content.replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The whole tree, incrementally
// ---------------------------------------------------------------------------

async function listTranscripts(root) {
  const out = [];
  async function walk(dir) {
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.name.endsWith('.jsonl')) out.push(p);
    }
  }
  await walk(root);
  return out;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.cache, 'utf8'));
  } catch {
    return { version: 2, sessions: {} };
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(PATHS.cache), { recursive: true });
  fs.writeFileSync(PATHS.cache, JSON.stringify(cache), 'utf8');
}

// ---------------------------------------------------------------------------
// Configuration, and whether it is actually in force
// ---------------------------------------------------------------------------

/**
 * The mod is configured in two places that load at different times:
 * `skillOverrides` is read live by the engine, while the plugin's own options
 * load with the module and need a restart. A half-applied change leaves the
 * skills callable but invisible, which is worse than either finished state —
 * so this reports the two halves separately rather than as one "config" blob.
 */
function readConfig() {
  let raw = null;
  let mtimeMs = null;
  try {
    raw = JSON.parse(fs.readFileSync(PATHS.settings, 'utf8'));
    mtimeMs = fs.statSync(PATHS.settings).mtimeMs;
  } catch {
    return { available: false };
  }
  const key = Object.keys(raw.pluginConfigs || {}).find((k) => k.startsWith('jev-skill-suggestion'));
  const opts = (key && raw.pluginConfigs[key].options) || {};
  const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    available: true,
    mtimeMs,
    pluginKey: key || null,
    provider: opts.provider || 'auto',
    baseUrl: opts.typesafeBaseUrl || null,
    model: opts.typesafeModel || null,
    hasKey: Boolean(opts.typesafeApiKey),
    hideListing: opts.hideListing !== false,
    inject: opts.inject || 'content',
    alwaysListed: split(opts.alwaysListed),
    neverSuggested: split(opts.neverSuggested),
    fitsThreshold: opts.fitsThreshold ?? 0.3,
    gateThreshold: opts.gateThreshold ?? 0.3,
    skillOverrides: raw.skillOverrides || {},
    disableBundledSkills: raw.disableBundledSkills === true,
    homeSet: Boolean(raw.env?.HOME),
  };
}

/** Checks that turn the configuration into a pass/warn/fail list. */
function auditConfig(config, sessions) {
  const checks = [];
  const add = (level, label, detail) => checks.push({ level, label, detail });

  if (!config.available) {
    add('fail', 'Settings unreadable', `Could not parse ${PATHS.settings}`);
    return checks;
  }

  // The backend. No key means the built-in classifier, which has no gate and
  // no second request — worth knowing, not a failure.
  if (config.provider === 'typesafe' && !config.hasKey) {
    add('fail', 'No API key for the forced backend', 'provider is "typesafe" but no key is set, so it silently degrades to the built-in classifier');
  } else if (config.hasKey) {
    add('pass', 'Backend', `${config.provider} at ${config.baseUrl || 'default'}, model ${config.model || 'jev-latest'}`);
  } else {
    add('warn', 'Built-in classifier', 'no key set: one request, no gate, no rerank');
  }

  // On Windows HOME is unset, and the mod builds user-level SKILL.md paths
  // from it. Report what was observed rather than what the setting implies:
  // an injection whose block names a directory under the user's .claude is
  // proof the path was resolved, and no amount of settings is.
  const userDirInjections = sessions
    .flatMap((s) => s.picks)
    .filter((p) => p.dir && /[\\/]\.claude[\\/]skills[\\/]/.test(p.dir) && !/[\\/]projects[\\/]/.test(p.dir));
  if (userDirInjections.length) {
    add('pass', 'User-level skills inject whole', `${userDirInjections.length} injection(s) came from a ~/.claude/skills path — observed, not inferred`);
  } else {
    add(
      config.homeSet ? 'warn' : 'fail',
      'User-level skills not yet seen injected',
      config.homeSet
        ? 'HOME is set, but no injection so far has come from ~/.claude/skills, so the path has not been shown to resolve'
        : 'HOME is unset and Windows does not provide it, so ~/.claude/skills/* can only be suggested by name',
    );
  }

  // Coherence: a skill cannot be both hidden from the model and kept in the
  // listing for it.
  const contradictions = config.alwaysListed.filter((n) => n in config.skillOverrides);
  add(
    contradictions.length ? 'fail' : 'pass',
    'alwaysListed and skillOverrides agree',
    contradictions.length ? `hidden yet always-listed: ${contradictions.join(', ')}` : `${config.alwaysListed.length} always-listed, ${Object.keys(config.skillOverrides).length} hidden`,
  );

  // Anything hidden should also be either injected by the mod or never wanted.
  const hiddenNotSuggestable = Object.keys(config.skillOverrides).filter((n) => config.neverSuggested.includes(n));
  if (hiddenNotSuggestable.length) {
    add('fail', 'Hidden and never suggested', `unreachable by any path: ${hiddenNotSuggestable.join(', ')} — the Skill tool refuses them and the mod will not offer them`);
  } else {
    add('pass', 'Nothing is unreachable by construction', 'no skill is both hidden and never-suggested');
  }

  // Whether the mod's own options are loaded cannot be read from a setting —
  // they load with the module, and the mod's "ready on ..." line goes to the
  // transcript view rather than the session file. Two things in the
  // transcripts do bear on it, and both are consequences rather than claims.
  const changedAt = config.mtimeMs;
  const since = (ts) => changedAt && Date.parse(ts) > changedAt;

  // 1. A suggestion naming a never-suggested skill can only happen if the
  //    option is not loaded.
  const blocked = sessions
    .flatMap((s) => s.picks)
    .filter((p) => since(p.ts) && config.neverSuggested.includes(p.skill));

  if (blocked.length) {
    add('fail', 'neverSuggested is not in force', `${blocked.length} suggestion(s) since the settings changed name a never-suggested skill (${[...new Set(blocked.map((p) => p.skill))].join(', ')}) — the module has not reloaded its options`);
  } else {
    // Only the negative is decisive. A Skill-tool call on an always-listed
    // skill does NOT prove the trimmed listing arrived: the model can call a
    // skill by a name it already knows, without ever seeing a listing — which
    // is exactly what happened the first time this check was written, and it
    // reported a pass on the strength of it.
    add('warn', "The mod's own options cannot be confirmed here", `settings changed ${fmtAgo(changedAt)}; no suggestion since has named a blocked skill, which is consistent with the options being loaded but does not show it. The mod logs "withheld the skill listing … kept listed: …" to the transcript view, and that line is the proof.`);
  }

  // What the transcripts do settle: whether the engine still refuses a skill.
  const refusals = sessions.flatMap((s) => s.refusals).filter((r) => since(r.ts));
  const calls = sessions.flatMap((s) => s.skillCalls).filter((c) => since(c.ts));
  if (refusals.length) {
    add('fail', 'The Skill tool refused a skill', `${refusals.length} refusal(s) since the settings changed`);
  } else if (calls.length) {
    add('pass', 'The Skill tool is accepting skills', `${calls.length} call(s) since the settings changed, none refused (${[...new Set(calls.map((c) => c.skill))].join(', ')})`);
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

// Per local day: the value of listings withheld and the cost of skill bodies injected, each booked on
// the day it entered the conversation — both accrue over the turns that follow, which may be later days.
// Same sources as the totals: withheld from main sessions, injected from every session.
function daily(main, sessions) {
  const byDay = new Map()
  const day = ts => {
    const d = new Date(ts)
    return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const at = k => byDay.get(k) || byDay.set(k, { date: k, withheld: 0, injected: 0 }).get(k)
  for (const s of main) for (const l of s.listings) { const k = day(l.ts); if (k) at(k).withheld += l.prefixValue }
  for (const s of sessions) for (const p of s.picks) { const k = day(p.ts); if (k) at(k).injected += p.prefixCost }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function aggregate(sessions, config) {
  const main = sessions.filter((s) => !s.isSubagent);
  const subs = sessions.filter((s) => s.isSubagent);

  const listingValue = main.reduce((a, s) => a + s.listingValue, 0);
  const injectionCost = sessions.reduce((a, s) => a + s.injectionCost, 0);
  const cacheRead = sessions.reduce((a, s) => a + s.usage.cacheRead, 0);
  const turns = sessions.reduce((a, s) => a + s.turns, 0);
  const prompts = main.reduce((a, s) => a + s.prompts, 0);

  const picks = sessions
    .flatMap((s) => s.picks.map((p) => ({ ...p, session: s.id, project: s.project })))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  const calls = sessions.flatMap((s) => s.skillCalls.map((c) => ({ ...c, session: s.id })));

  // Per skill: offered, injected, called. A skill with neither a suggestion nor
  // a call is one nothing can reach — konnect was in exactly that state.
  const bySkill = new Map();
  const touch = (name) => {
    if (!bySkill.has(name)) bySkill.set(name, { skill: name, suggested: 0, injected: 0, namedOnly: 0, repeats: 0, tokens: 0, prefixCost: 0, called: 0 });
    return bySkill.get(name);
  };
  for (const p of picks) {
    const r = touch(p.skill);
    r.suggested++;
    if (p.whole) r.injected++;
    else r.namedOnly++;
    if (p.repeat) r.repeats++;
    r.tokens += p.tokens;
    r.prefixCost += p.prefixCost;
  }
  for (const c of calls) touch(c.skill).called++;
  for (const n of config.alwaysListed || []) touch(n);
  for (const n of Object.keys(config.skillOverrides || {})) touch(n);
  // Anything the newest listing named is part of the roster, so a skill that is
  // listed yet never used still shows up rather than silently vanishing.
  const newestListing = main
    .flatMap((s) => s.listings)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  for (const n of newestListing?.names || []) touch(n);

  // Each skill's state is what the *settings* say about it, labelled as such.
  // An earlier version asserted the consequences — "the Skill tool refuses
  // it", "kept in the listing" — which this cannot see: `skillOverrides` is
  // read live by the engine, but the mod's own two lists only take effect once
  // the module has loaded them, and nothing in a transcript says whether it
  // has. The offered and called columns beside this are the observation; this
  // column is only the configuration.
  const skills = [...bySkill.values()].map((r) => {
    const hidden = r.skill in (config.skillOverrides || {});
    const never = (config.neverSuggested || []).includes(r.skill);
    const listed = (config.alwaysListed || []).includes(r.skill);
    const tags = [];
    if (hidden) tags.push('hidden');
    if (listed) tags.push('always listed');
    if (never) tags.push('not offered');
    const source = [
      hidden ? 'skillOverrides (live)' : null,
      listed || never ? "the mod's options (need the module to have loaded them)" : null,
    ].filter(Boolean).join('; ');
    return {
      ...r,
      hidden,
      never,
      listed,
      state: tags.length ? tags.join(' + ') : 'default',
      note: tags.length ? `from ${source}` : 'no override in settings',
      quiet: r.suggested === 0 && r.called === 0,
    };
  }).sort((a, b) => b.prefixCost - a.prefixCost || b.suggested - a.suggested || a.skill.localeCompare(b.skill));

  // The same skill injected whole more than once in one session: each restart
  // or compaction pays the full body again.
  const reinjected = [];
  for (const s of sessions) {
    const seen = new Map();
    for (const p of s.picks) {
      if (!p.whole) continue;
      seen.set(p.skill, (seen.get(p.skill) || 0) + 1);
    }
    for (const [skill, n] of seen) {
      if (n > 1) reinjected.push({ session: s.id, project: s.project, skill, times: n, tokens: n * (s.picks.find((p) => p.skill === skill)?.tokens || 0) });
    }
  }

  return {
    timeline: daily(main, sessions),
    totals: {
      sessions: main.length,
      subagentSessions: subs.length,
      turns,
      prompts,
      suggestions: picks.length,
      promptsWithoutSuggestion: Math.max(0, prompts - picks.length),
      skillToolCalls: calls.length,
      refusals: sessions.reduce((a, s) => a + s.refusals.length, 0),
      listingValue,
      injectionCost,
      net: listingValue - injectionCost,
      cacheRead,
      sessionsModObserved: main.filter((s) => s.modObserved).length,
      // The sum is dominated by whichever session ran longest, because an
      // injection early in a 4,000-turn session is charged on every turn after
      // it. Reporting only the total hides that most sessions come out ahead,
      // so carry the split and the worst offender beside it.
      sessionsPositive: main.filter((s) => s.listingValue - s.injectionCost >= 0).length,
      sessionsNegative: main.filter((s) => s.listingValue - s.injectionCost < 0).length,
      worstSession: main
        .map((s) => ({ id: s.id, project: s.project, turns: s.turns, net: s.listingValue - s.injectionCost }))
        .sort((a, b) => a.net - b.net)[0] || null,
      netShare: cacheRead ? (100 * (listingValue - injectionCost)) / cacheRead : 0,
      // Valued the same way as a withheld listing — size times the turns it
      // rode — so the two are comparable. Summing the raw sizes instead (which
      // this did) put a number next to "listings withheld" that was computed
      // differently and read as if it were the same kind of thing.
      subagentListingValue: subs.reduce((a, s) => a + s.listings.reduce((b, l) => b + l.tokens * s.turns, 0), 0),
      subagentPicks: subs.reduce((a, s) => a + s.picks.length, 0),
    },
    skills,
    picks: picks.slice(0, 40),
    reinjected: reinjected.sort((a, b) => b.tokens - a.tokens),
    sessions: main
      .slice()
      .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))
      .slice(0, 20)
      .map((s) => ({
        id: s.id,
        project: s.project,
        modObserved: s.modObserved,
        start: s.start,
        end: s.end,
        turns: s.turns,
        prompts: s.prompts,
        suggestions: s.picks.length,
        skillToolCalls: s.skillCalls.length,
        compactions: s.compactions,
        listings: s.listings.length,
        listingSkills: s.listings.at(-1)?.skillCount ?? null,
        listingTokens: s.listings.at(-1)?.tokens ?? 0,
        listingValue: s.listingValue,
        injectionCost: s.injectionCost,
        cacheRead: s.usage.cacheRead,
      })),
  };
}

const fmtAgo = (ms) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// The parsed sessions behind the last snapshot, kept so a windowed view is a
// filter and a second aggregate() rather than a second parse.
let lastSessions = null;
let lastConfig = null;

/**
 * The snapshot restricted to sessions active in the last `days` days: those
 * whose last entry falls inside the window. A session that began earlier is
 * counted whole — its full prefix cost — rather than split at the boundary.
 * `checks` and `config` describe the present and are not windowed. Null until
 * evaluate() has run in this process. Nothing is written to disk.
 */
export function windowed(snapshot, days) {
  if (!lastSessions || !snapshot) return null;
  const cutoff = Date.now() - days * 86_400_000;
  const inWindow = lastSessions.filter((s) => Date.parse(s.end) >= cutoff);
  return {
    ...snapshot,
    ...aggregate(inWindow, lastConfig),
    window: { days, sessions: inWindow.filter((s) => !s.isSubagent).length, countedWhole: true },
  };
}

/** Re-read whatever changed and return a complete snapshot. */
export async function evaluate() {
  const startedAt = Date.now();
  const cache = loadCache();
  const files = await listTranscripts(PATHS.projects);
  const sessions = [];
  let reparsed = 0;
  let skipped = 0;

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const hit = cache.sessions[file];
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      if (hit.session) sessions.push(hit.session);
      skipped++;
      continue;
    }
    const session = readSession(file, stat);
    // A miss is cached too (null session), so files that predate the mod are
    // not re-read every tick.
    cache.sessions[file] = { mtimeMs: stat.mtimeMs, size: stat.size, session };
    if (session) sessions.push(session);
    reparsed++;
  }

  for (const known of Object.keys(cache.sessions)) {
    if (!files.includes(known)) delete cache.sessions[known];
  }
  saveCache(cache);

  const config = readConfig();
  const agg = aggregate(sessions, config);
  lastSessions = sessions;
  lastConfig = config;
  const snapshot = {
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    scanned: { files: files.length, reparsed, fromCache: skipped, withMod: sessions.length },
    provenance: {
      measured: 'character counts, turn counts, call counts, timestamps',
      reported: 'cache-read, cache-write and output token counts, from the API',
      estimated: `every token figure derived from characters, at ${CHARS_PER_TOKEN} chars/token`,
    },
    config: { ...config, apiKeyRedacted: config.hasKey ? 'set (not read)' : 'none', typesafeApiKey: undefined },
    checks: auditConfig(config, sessions),
    ...agg,
  };

  fs.mkdirSync(path.dirname(PATHS.snapshot), { recursive: true });
  fs.writeFileSync(PATHS.snapshot, JSON.stringify(snapshot, null, 2), 'utf8');
  return snapshot;
}

export function lastSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.snapshot, 'utf8'));
  } catch {
    return null;
  }
}

// `node meter.mjs` — evaluate once and print the headline.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const s = await evaluate();
  const t = s.totals;
  console.log(`scanned ${s.scanned.files} transcripts (${s.scanned.reparsed} re-parsed) in ${s.tookMs} ms`);
  console.log(`${t.sessions} sessions with the mod, ${t.prompts} prompts, ${t.suggestions} suggestions, ${t.skillToolCalls} Skill-tool calls`);
  console.log(`withheld ${t.listingValue.toLocaleString()} - injected ${t.injectionCost.toLocaleString()} = net ${t.net.toLocaleString()} cache-read tokens (${t.netShare.toFixed(2)}% of ${t.cacheRead.toLocaleString()})`);
  for (const c of s.checks) console.log(`  [${c.level}] ${c.label}: ${c.detail}`);
}
