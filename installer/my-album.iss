; 我的相册 · 安装包脚本（Inno Setup 6）
;
; 编译（打包脚本会自动带上这两个 /D 参数）：
;   ISCC.exe /DMyAppVersion=2.0.0 /DMyPayload=build\pack\staging installer\my-album.iss
;
; 按用户定的方案：
;   · 按用户安装（per-user，不弹 UAC）：默认装到 %LOCALAPPDATA%\Programs\我的相册
;     —— 这是"缓存 / 索引 / 设置都放安装目录"能成立的前提（那个目录当前用户可写）
;   · 缓存 / 索引 / 设置全在安装目录里（启动器把该目录传给服务）
;   · 卸载时**直接删掉** cache\ 和 data\（用户明确要求）
;   · 附加功能只做一件事：桌面快捷方式
;
; 如果用户手动把目录改成 C:\Program Files，普通权限就写不进去（会有 UAC 虚拟化），
; 所以那种情况下给 cache / data 补一个写权限；服务端也还有"不可写就退到用户目录"的兜底。

#ifndef MyAppVersion
  #define MyAppVersion "2.0.0"
#endif

#ifndef MyPayload
  #define MyPayload "..\build\pack\staging"
#endif

#define MyAppName "我的相册"
#define MyAppPublisher "My Album"
#define MyAppExeName "MyAlbum.exe"

[Setup]
AppId={{8F3C1D64-7B2A-4E51-9C6D-5A1E2B7F4C90}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=no
; 按用户安装：不请求管理员权限，缓存才写得进安装目录
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
AllowNoIcons=yes
; 升级/重装默认沿用上次的目录（缓存和索引都在那里，别换地方）
UsePreviousAppDir=yes
UsePreviousLanguage=yes
OutputDir=..\成品
OutputBaseFilename=我的相册-{#MyAppVersion}-安装包
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName} {#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 安装/卸载时让正在运行的相册先关掉，避免文件占用
CloseApplications=yes
RestartApplications=no
MinVersion=10.0

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
; 用户要求：附加功能只留一个桌面快捷方式
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："

[Files]
; 整个载荷：runtime\node.exe + app\ + MyAlbum.exe + install.json
Source: "{#MyPayload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; 预建两个目录，用户第一眼就能看到"数据在哪"（卸载时会删掉）
Source: "{#MyPayload}\install.json"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; 缓存/索引目录：卸载时连内容一起删（见 [UninstallDelete]）
Name: "{app}\cache"; Permissions: users-modify
Name: "{app}\data"; Permissions: users-modify

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 用户要求：卸载时缓存直接删（索引和设置也在安装目录里，一并删掉）
Type: filesandordirs; Name: "{app}\cache"
Type: filesandordirs; Name: "{app}\data"
; 安装目录里可能还留着日志/临时文件，整个目录一起收干净（Inno 会跳过自己跟踪的文件）
Type: filesandordirs; Name: "{app}"

[Code]
// 如果用户坚持装到 Program Files 这类"普通用户写不进去"的地方，
// 就给 cache / data 补一个写权限；补不上也没关系 —— 服务启动时会自己退到
// %LOCALAPPDATA%\我的相册 并在日志里说明（见 lib/app-paths.js）。
procedure GrantCacheWriteAccess();
var
  ResultCode: Integer;
begin
  if IsAdminInstallMode then
  begin
    Exec('icacls.exe',
      ExpandConstant('"{app}\cache" /grant *S-1-5-32-545:(OI)(CI)M /T /C'),
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('icacls.exe',
      ExpandConstant('"{app}\data" /grant *S-1-5-32-545:(OI)(CI)M /T /C'),
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    GrantCacheWriteAccess();
    // 建出空目录，免得第一次运行时用户以为"没装上"
    ForceDirectories(ExpandConstant('{app}\cache'));
    ForceDirectories(ExpandConstant('{app}\data'));
  end;
end;