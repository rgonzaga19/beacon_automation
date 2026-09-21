; -------------------------------
; Beabots Installer
; -------------------------------

#define MyAppName "Beabots"
#define MyAppVersion "4.0.5"
#define MyAppPublisher "Romel Gonzaga"
#define MyAppURL "https://github.com/rgonzaga19/beacon_automation"
#define MyAppUpdatesURL "https://beabot-license.gonzagaromel19.workers.dev/update"
#define MyAppExeName "Beabots.exe"

[Setup]
; Never change this AppId. Inno Setup uses it to recognize and upgrade every
; previous Beabots installation instead of creating a second uninstall entry.
AppId={{D2A91D2F-0B2F-4B8E-9B79-4B2B5A8D7F01}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppUpdatesURL}

DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
UsePreviousAppDir=yes
PrivilegesRequired=admin

DisableProgramGroupPage=yes

OutputDir=Output
OutputBaseFilename=Beabots_Setup_v{#MyAppVersion}

Compression=lzma
SolidCompression=yes
WizardStyle=modern

SetupIconFile=renderer\assets\bot.ico

ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
AppMutex=Beabots-D2A91D2F-0B2F-4B8E-9B79-4B2B5A8D7F01

UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a Desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
; dist\Beabots is PyInstaller's one-folder output from Beabots.spec.
Source: "dist\Beabots\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Beabots"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Beabots"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Beabots"; Flags: nowait postinstall skipifsilent
