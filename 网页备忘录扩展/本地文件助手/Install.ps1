param([string]$ExtensionId)
$ErrorActionPreference = 'Stop'

# 程序安装目录：优先 D 盘，其次 E 盘，最后回退到系统用户目录。
function Resolve-ProgramDir {
    if ($env:WEBMEMO_INSTALL_DIR) { return $env:WEBMEMO_INSTALL_DIR }
    foreach ($drive in @('D', 'E')) {
        $root = $drive + ':\'
        if (Test-Path -LiteralPath $root) { return (Join-Path $root '网页备忘录助手') }
    }
    return (Join-Path $env:LOCALAPPDATA 'WebMemoLocalFiles')
}

# 数据目录：与 MemoHost.exe 内部的解析规则保持一致（D 盘 > E 盘 > 用户目录）。
function Resolve-DataDir {
    if ($env:WEBMEMO_ROOT) { return $env:WEBMEMO_ROOT }
    foreach ($drive in @('D', 'E')) {
        $root = $drive + ':\'
        if (Test-Path -LiteralPath $root) { return (Join-Path $root '网页备忘录数据') }
    }
    return (Join-Path $env:LOCALAPPDATA 'WebMemoLocalFiles')
}

try {
    Write-Host 'Web Memo local file helper - Windows / Edge'
    Write-Host 'Copy the extension ID from Edge > Extensions > Web Memo > Details.'
    if (-not $ExtensionId) { $ExtensionId = Read-Host 'Paste extension ID (32 characters)' }
    $ExtensionId = $ExtensionId.Trim()
    if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'Invalid ID. Copy the 32-character extension ID from Edge.' }

    $installDir = Resolve-ProgramDir
    $dataDir = Resolve-DataDir
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Write-Host ('Program folder: ' + $installDir)
    Write-Host ('Data folder:    ' + $dataDir)

    # 把以前留在 C 盘的登记记录和解压副本搬到新位置，避免已关联的文献失效。
    $oldDir = Join-Path $env:LOCALAPPDATA 'WebMemoLocalFiles'
    $oldIndex = Join-Path $oldDir 'links.json'
    $newIndex = Join-Path $dataDir 'links.json'
    if ((Test-Path -LiteralPath $oldIndex) -and -not (Test-Path -LiteralPath $newIndex) -and ($oldDir -ne $dataDir)) {
        Write-Host 'Migrating existing records out of C: ...'
        $oldExtracted = Join-Path $oldDir 'Extracted'
        if (Test-Path -LiteralPath $oldExtracted) {
            Copy-Item -LiteralPath $oldExtracted -Destination $dataDir -Recurse -Force
        }
        # links.json 里存的是绝对路径，需要把旧前缀替换成新前缀（JSON 中反斜杠是双写的）。
        $raw = Get-Content -LiteralPath $oldIndex -Raw -Encoding UTF8
        $raw = $raw.Replace($oldDir.Replace('\', '\\'), $dataDir.Replace('\', '\\'))
        [System.IO.File]::WriteAllText($newIndex, $raw, (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $newIndex) {
            if (Test-Path -LiteralPath $oldExtracted) { Remove-Item -LiteralPath $oldExtracted -Recurse -Force -ErrorAction SilentlyContinue }
            Rename-Item -LiteralPath $oldIndex -NewName 'links.json.migrated-backup' -ErrorAction SilentlyContinue
            Write-Host 'Migration finished. Old C: copy removed; a backup of the old index was kept.' -ForegroundColor Green
        }
    }

    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler not found. .NET Framework 4.x is required.' }
    $source = Join-Path $PSScriptRoot 'MemoHost.cs'
    $pending = Join-Path $installDir 'MemoHost.new.exe'
    $exe = Join-Path $installDir 'MemoHost.exe'
    & $compiler '/nologo' '/target:exe' '/platform:anycpu' '/codepage:65001' '/reference:System.Drawing.dll' '/reference:System.IO.Compression.dll' '/reference:System.IO.Compression.FileSystem.dll' '/reference:System.Windows.Forms.dll' '/reference:System.Web.Extensions.dll' "/out:$pending" $source
    if ($LASTEXITCODE -ne 0) { throw 'Compilation failed. Keep the output above for troubleshooting.' }
    Write-Host 'Running ZIP, rename and FileDrop data self-test...'
    & $pending '--self-test'
    if ($LASTEXITCODE -ne 0) { throw 'Local helper self-test failed. The previous helper was not replaced.' }
    Move-Item -LiteralPath $pending -Destination $exe -Force
    $manifest = [ordered]@{
        name = 'com.webmemo.localfiles'
        description = 'Web Memo local file and folder links'
        path = $exe
        type = 'stdio'
        allowed_origins = @("chrome-extension://$ExtensionId/")
    }
    $manifestPath = Join-Path $installDir 'com.webmemo.localfiles.json'
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8)
    $regPath = 'Software\Microsoft\Edge\NativeMessagingHosts\com.webmemo.localfiles'
    $registry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($regPath)
    try { $registry.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $registry.Dispose() }

    # 注册表已指向新位置，清掉 C 盘旧目录里的程序文件（只删助手自己的文件，不动备份）。
    if ($oldDir -ne $installDir) {
        foreach ($stale in @('MemoHost.exe', 'MemoHost.new.exe', 'com.webmemo.localfiles.json')) {
            Remove-Item -LiteralPath (Join-Path $oldDir $stale) -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host ''
    Write-Host 'Installation complete. Click Check Connection in the extension settings.' -ForegroundColor Green
    Write-Host 'No administrator access or Python installation is needed.'
    Write-Host ('All helper files and extracted copies now live on ' + $dataDir)
    exit 0
} catch {
    Write-Host ('Installation failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
