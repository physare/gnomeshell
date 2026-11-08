' Starts GnomeShell without a console window. The window opens at once on a
' loading screen (web\splash.html), which turns into the app as soon as the
' engine is up; the engine is told not to open a second window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
splash = dir & "\web\splash.html"

browser = ""
For Each p In Array(sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
                    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
                    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
                    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
                    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe")
  If browser = "" And fso.FileExists(p) Then browser = p
Next

If browser <> "" And fso.FileExists(splash) Then
  base = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\GnomeShell"
  profile = base & "\window"
  If Not fso.FolderExists(base) Then fso.CreateFolder(base)
  If Not fso.FolderExists(profile) Then fso.CreateFolder(profile)
  url = "file:///" & Replace(Replace(Replace(splash, "\", "/"), " ", "%20"), "#", "%23")
  sh.Run """" & browser & """ --app=""" & url & """ --user-data-dir=""" & profile & """ --start-fullscreen --no-first-run --no-default-browser-check --disable-features=Translate", 1, False
  sh.Environment("PROCESS")("GNOMESHELL_SPLASH") = "1"
End If
sh.Run """" & dir & "\GnomeShell.bat"" hidden", 0, False
