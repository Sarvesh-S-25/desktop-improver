' Starts Desktop Pods in safe test mode (sandbox folder, yellow "Test" badges).
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & here & "\node_modules\electron\dist\electron.exe"" """ & here & """ --sandbox", 0, False
