' Starts Desktop Pods (real mode) without a console window.
' Running it again while Pods is open just opens the Hub.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & here & "\node_modules\electron\dist\electron.exe"" """ & here & """", 0, False
