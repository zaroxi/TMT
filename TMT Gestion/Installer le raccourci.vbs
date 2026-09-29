' Crée le raccourci « TMT Gestion » sur le Bureau (et, si vous le souhaitez, au démarrage de Windows)
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dossier = fso.GetParentFolderName(WScript.ScriptFullName)
bat = dossier & "\Lancer TMT Gestion.bat"
If Not fso.FileExists(bat) Or Not fso.FileExists(dossier & "\serveur\server.js") Then
  MsgBox "Fichiers de TMT Gestion introuvables dans :" & vbCrLf & dossier, 16, "TMT Gestion"
  WScript.Quit
End If
' Node.js installé ?
nodeOk = True
On Error Resume Next
r = sh.Run("cmd /c where node >nul 2>nul", 0, True)
If Err.Number <> 0 Or r <> 0 Then nodeOk = False
On Error GoTo 0
Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\TMT Gestion.lnk")
lnk.TargetPath = bat
lnk.WorkingDirectory = dossier
lnk.WindowStyle = 7
lnk.IconLocation = dossier & "\tmt.ico,0"
lnk.Description = "TMT Gestion - pointage des trajets (base de données)"
lnk.Save
msg = "Le raccourci « TMT Gestion » a été créé sur le Bureau."
rep = MsgBox(msg & vbCrLf & vbCrLf & "Lancer aussi le serveur TMT Gestion automatiquement à l'ouverture de la session Windows ?" & vbCrLf & "(conseillé sur l'ordinateur principal si d'autres postes ou le téléphone l'utilisent)", 36, "TMT Gestion")
If rep = 6 Then
  Set st = sh.CreateShortcut(sh.SpecialFolders("Startup") & "\TMT Gestion (serveur).lnk")
  st.TargetPath = bat
  st.Arguments = "/demarrage"
  st.WorkingDirectory = dossier
  st.WindowStyle = 7
  st.IconLocation = dossier & "\tmt.ico,0"
  st.Description = "TMT Gestion - serveur local"
  st.Save
  MsgBox "C'est fait : le serveur démarrera avec Windows (fenêtre réduite dans la barre des tâches).", 64, "TMT Gestion"
End If
If Not nodeOk Then
  MsgBox "Attention : Node.js n'est pas encore installé sur cet ordinateur." & vbCrLf & "Installez la version LTS depuis https://nodejs.org (voir LISEZMOI, étape 1), puis double-cliquez sur l'icône TMT Gestion.", 48, "TMT Gestion"
End If
