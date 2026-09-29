' Starts the dashboard server with no console window, for the agent-routing
' scheduled task. Same shim as jev-meter's run.vbs, for the same reasons:
'
' Task Scheduler's "Hidden" checkbox does not reliably hide a console window;
' WScript.Shell's Run with intWindowStyle 0 does, and needs nothing installed.
'
' Argument 3 (bWaitOnReturn) is True on purpose: the shim blocks for as long as
' the server runs, so the task reads Running and its restart-on-failure settings
' apply to the server rather than to a shim that exited at once.

Dim shell, here, node, server
Set shell = CreateObject("WScript.Shell")

here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
server = here & "server.mjs"

If Not CreateObject("Scripting.FileSystemObject").FileExists(node) Then
  node = "node.exe"
End If

shell.CurrentDirectory = here
WScript.Quit shell.Run("""" & node & """ """ & server & """", 0, True)
