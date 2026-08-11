import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeReleaseChecksums } from "./release-checksums.mjs";

const root = new URL("../", import.meta.url).pathname;
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const release = join(root, "release");
const macApp = join(release, "Capacity Atlas Connector.app");
const macContents = join(macApp, "Contents");
const macResources = join(macContents, "Resources");
const macBin = join(macContents, "MacOS");
const windowsDir = join(release, "Capacity Atlas Connector Windows");

await rm(macApp, { recursive: true, force: true });
await rm(windowsDir, { recursive: true, force: true });
await mkdir(macResources, { recursive: true });
await mkdir(macBin, { recursive: true });
await mkdir(windowsDir, { recursive: true });

await copyFile(join(release, "capacity-atlas-macos-arm64"), join(macResources, "connector"));
await copyFile(join(root, "vendor/codex/macos-arm64/codex"), join(macResources, "codex"));
await copyFile(join(root, "vendor/codex/LICENSE"), join(macResources, "OPENAI_CODEX_LICENSE"));
await chmod(join(macResources, "connector"), 0o755);
await chmod(join(macResources, "codex"), 0o755);
const launcherSource = join(release, "CapacityAtlasLauncher.swift");
await writeFile(launcherSource, `import Foundation
import AppKit
import Darwin

let healthURL = URL(string: "http://127.0.0.1:4174/api/health")!
let runtimeURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".capacity-atlas/runtime.json")

struct Health: Decodable { let name: String; let ready: Bool }
struct RuntimeInfo: Decodable { let name: String; let pid: Int32; let port: Int; let token: String }

func connectorIsReady() -> Bool {
    guard let data = try? Data(contentsOf: healthURL),
          let health = try? JSONDecoder().decode(Health.self, from: data) else { return false }
    return health.name == "Capacity Atlas Connector" && health.ready
}

func runAndCapture(_ executable: String, _ arguments: [String]) -> String {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return "" }
    process.waitUntilExit()
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

func pidForConnectorPort() -> Int32? {
    return Int32(runAndCapture("/usr/sbin/lsof", ["-tiTCP:4174", "-sTCP:LISTEN"]))
}

func executableForPID(_ pid: Int32) -> String {
    return runAndCapture("/bin/ps", ["-p", String(pid), "-o", "comm="])
}

func verifiedLegacyPID() -> Int32? {
    guard let pid = pidForConnectorPort() else { return nil }
    let executable = executableForPID(pid)
    let knownPath = executable.hasSuffix("/Capacity Atlas Connector.app/Contents/Resources/connector")
        || executable.hasSuffix("/Capacity Atlas.app/Contents/Resources/connector")
    return knownPath ? pid : nil
}

func connectorOwnedAndReady(_ pid: Int32, _ token: String) -> Bool {
    guard connectorIsReady(), pidForConnectorPort() == pid,
          let data = try? Data(contentsOf: runtimeURL),
          let runtime = try? JSONDecoder().decode(RuntimeInfo.self, from: data) else { return false }
    return runtime.name == "Capacity Atlas Connector" && runtime.pid == pid && runtime.port == 4174 && runtime.token == token
}

func waitForStop(_ pid: Int32, attempts: Int = 40) -> Bool {
    for _ in 0..<attempts {
        if kill(pid, 0) != 0 { return true }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return false
}

func requestGracefulStop(_ runtime: RuntimeInfo) -> Bool {
    guard runtime.name == "Capacity Atlas Connector", runtime.port == 4174, runtime.token.count >= 20,
          pidForConnectorPort() == runtime.pid else { return false }
    var request = URLRequest(url: URL(string: "http://127.0.0.1:4174/api/shutdown")!)
    request.httpMethod = "POST"
    request.setValue(runtime.token, forHTTPHeaderField: "x-capacity-atlas-token")
    let semaphore = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, _, _ in semaphore.signal() }.resume()
    _ = semaphore.wait(timeout: .now() + 2)
    return waitForStop(runtime.pid)
}

var previousProcessStopped = true
if connectorIsReady() {
    previousProcessStopped = false
    if let data = try? Data(contentsOf: runtimeURL),
       let runtime = try? JSONDecoder().decode(RuntimeInfo.self, from: data) {
        previousProcessStopped = requestGracefulStop(runtime)
    } else if let pid = verifiedLegacyPID() {
        _ = kill(pid, SIGTERM)
        previousProcessStopped = waitForStop(pid)
        if !previousProcessStopped, verifiedLegacyPID() == pid {
            _ = kill(pid, SIGKILL)
            previousProcessStopped = waitForStop(pid, attempts: 10)
        }
    }
}

if !previousProcessStopped || connectorIsReady() {
    let alert = NSAlert()
    alert.messageText = "Capacity Atlas Connectorを更新できませんでした"
    alert.informativeText = "実行中のConnectorを終了してから、もう一度開いてください。"
    alert.runModal()
    exit(1)
}

guard let resources = Bundle.main.resourceURL else { exit(1) }
let token = UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
let stateDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".capacity-atlas")
try? FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
let logURL = stateDirectory.appendingPathComponent("connector.log")
FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
let log = try? FileHandle(forWritingTo: logURL)
try? log?.truncate(atOffset: 0)
let connector = Process()
connector.executableURL = resources.appendingPathComponent("connector")
connector.currentDirectoryURL = resources
connector.standardOutput = log
connector.standardError = log
connector.environment = ProcessInfo.processInfo.environment.merging(["CAPACITY_ATLAS_TOKEN": token]) { _, new in new }

do {
    try connector.run()
} catch {
    let alert = NSAlert()
    alert.messageText = "Capacity Atlas Connectorを起動できませんでした"
    alert.informativeText = error.localizedDescription
    alert.runModal()
    exit(1)
}

for _ in 0..<80 {
    if connectorOwnedAndReady(connector.processIdentifier, token) { break }
    if !connector.isRunning { break }
    Thread.sleep(forTimeInterval: 0.1)
}

guard connectorOwnedAndReady(connector.processIdentifier, token) else {
    connector.terminate()
    exit(1)
}
NSWorkspace.shared.open(URL(string: "http://127.0.0.1:4174/#token=" + token)!)
connector.waitUntilExit()
`);
execFileSync("xcrun", ["swiftc", "-O", "-framework", "AppKit", launcherSource, "-o", join(macBin, "Capacity Atlas Connector")], { stdio: "inherit" });
await rm(launcherSource, { force: true });
await writeFile(join(macContents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleName</key><string>Capacity Atlas Connector</string>\n<key>CFBundleDisplayName</key><string>Capacity Atlas Connector</string>\n<key>CFBundleIdentifier</key><string>jp.meem.capacity-atlas.connector</string>\n<key>CFBundleVersion</key><string>${version}</string>\n<key>CFBundleShortVersionString</key><string>${version}</string>\n<key>CFBundleExecutable</key><string>Capacity Atlas Connector</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>LSUIElement</key><true/>\n<key>LSMinimumSystemVersion</key><string>14.0</string>\n</dict></plist>\n`);
await copyFile(join(root, "THIRD_PARTY_NOTICES.md"), join(macResources, "THIRD_PARTY_NOTICES.md"));

await copyFile(join(release, "capacity-atlas-win-x64.exe"), join(windowsDir, "capacity-atlas-connector.exe"));
await copyFile(join(root, "vendor/codex/windows-x64/codex.exe"), join(windowsDir, "codex.exe"));
await copyFile(join(root, "vendor/codex/LICENSE"), join(windowsDir, "OPENAI_CODEX_LICENSE.txt"));
await copyFile(join(root, "THIRD_PARTY_NOTICES.md"), join(windowsDir, "THIRD_PARTY_NOTICES.md"));
await writeFile(join(windowsDir, "Start-CapacityAtlas.ps1"), `\uFEFF$ErrorActionPreference = 'Stop'
$healthUri = 'http://127.0.0.1:4174/api/health'
$shutdownUri = 'http://127.0.0.1:4174/api/shutdown'
$runtimePath = Join-Path $HOME '.capacity-atlas\\runtime.json'
$connectorPath = Join-Path $PSScriptRoot 'capacity-atlas-connector.exe'

function Get-CapacityHealth {
  try {
    $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 1
    if ($health.name -eq 'Capacity Atlas Connector' -and $health.ready) { return $health }
  } catch {}
  return $null
}

function Wait-CapacityStop([int]$ProcessId, [int]$Attempts = 40) {
  foreach ($attempt in 1..$Attempts) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 100
  }
  return $false
}

function Get-PortOwner {
  try { return (Get-NetTCPConnection -LocalPort 4174 -State Listen | Select-Object -First 1).OwningProcess } catch { return $null }
}

function Test-CapacityOwnedReady([int]$ProcessId, [string]$Token) {
  try {
    $health = Get-CapacityHealth
    if (-not $health) { return $false }
    $runtime = Get-Content -Raw -Path $runtimePath | ConvertFrom-Json
    return (Get-PortOwner) -eq $ProcessId -and $runtime.pid -eq $ProcessId -and $runtime.port -eq 4174 -and $runtime.token -eq $Token
  } catch { return $false }
}

if (Get-CapacityHealth) {
  $stopped = $false
  $managedRuntime = $false
  if (Test-Path $runtimePath) {
    try {
      $runtime = Get-Content -Raw -Path $runtimePath | ConvertFrom-Json
      $owner = Get-PortOwner
      $process = Get-Process -Id $runtime.pid -ErrorAction Stop
      if ($runtime.name -ne 'Capacity Atlas Connector' -or $runtime.port -ne 4174 -or $runtime.token.Length -lt 20) { throw 'Invalid runtime metadata' }
      if ($owner -ne $runtime.pid -or $process.ProcessName -ne 'capacity-atlas-connector') { throw 'Runtime owner mismatch' }
      $managedRuntime = $true
      try {
        Invoke-RestMethod -Method Post -Uri $shutdownUri -Headers @{ 'x-capacity-atlas-token' = $runtime.token } -TimeoutSec 8 | Out-Null
      } catch {}
      $stopped = Wait-CapacityStop -ProcessId $runtime.pid -Attempts 120
    } catch {
      if ($managedRuntime) { throw }
    }
  }
  if ($managedRuntime -and -not $stopped) {
    throw 'Connectorの認証処理を安全に終了できませんでした。認証を閉じてから再試行してください。'
  }
  if (-not $stopped -and (Get-CapacityHealth)) {
    $owner = Get-PortOwner
    if ($owner) {
      $process = Get-Process -Id $owner -ErrorAction Stop
      $expectedFolder = 'Capacity Atlas Connector Windows'
      if ($process.ProcessName -ne 'capacity-atlas-connector' -or (Split-Path (Split-Path $process.Path -Parent) -Leaf) -ne $expectedFolder) {
        throw '実行中の別プロセスを安全に確認できませんでした。Connectorを手動で終了してください。'
      }
      $children = Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $owner)
      if ($children) { throw '認証処理が実行中です。認証画面を閉じてから再試行してください。' }
      Stop-Process -Id $owner
      $stopped = Wait-CapacityStop -ProcessId $owner
    }
  }
  if (-not $stopped) { throw '実行中のConnectorを終了できませんでした。手動で終了してから再試行してください。' }
}

$bytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
$generator.GetBytes($bytes)
$generator.Dispose()
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
$env:CAPACITY_ATLAS_TOKEN = $token
$process = Start-Process -FilePath $connectorPath -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
$ready = $false
foreach ($attempt in 1..80) {
  if (Test-CapacityOwnedReady -ProcessId $process.Id -Token $token) { $ready = $true; break }
  if ($process.HasExited) { break }
  Start-Sleep -Milliseconds 100
}
if (-not $ready) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
  throw 'Capacity Atlas Connectorを起動できませんでした。'
}
Start-Process ('http://127.0.0.1:4174/#token=' + $token)
`);
await writeFile(join(windowsDir, "Start Capacity Atlas.cmd"), `@echo off\r\nsetlocal\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CapacityAtlas.ps1"\r\nif errorlevel 1 (\r\n  echo Capacity Atlas Connectorを起動できませんでした。画面の案内を確認してください。\r\n  pause\r\n  exit /b 1\r\n)\r\n`);
await writeFile(join(windowsDir, "README.txt"), `Capacity Atlas Connector ${version}\r\n\r\n日本語\r\n1. ZIP内の全ファイルを同じフォルダへ展開します。\r\n2. Start Capacity Atlas.cmd をダブルクリックします。\r\n3. SmartScreenが表示された場合は、GitHub Releaseの配布元・ファイル名・SHA-256を確認した場合だけ「詳細情報」→「実行」を選びます。現在の配布版はコード署名前です。\r\n4. ブラウザが開かない場合は、Start Capacity Atlas.cmd をもう一度実行します。\r\n5. GPT / Codexの認証機能は同梱されています。Claude・Grokは初回接続時に公式認証機能を自動で準備します。\r\n\r\nSHA-256確認例（PowerShell）:\r\nGet-FileHash .\\Capacity-Atlas-Connector-Windows-x64.zip -Algorithm SHA256\r\n\r\nEnglish\r\n1. Extract every file from the ZIP into the same folder.\r\n2. Double-click Start Capacity Atlas.cmd.\r\n3. This release is not yet code-signed. Use SmartScreen's More info > Run anyway only after verifying the GitHub Release source, filename, and SHA-256.\r\n4. If the browser does not open, run Start Capacity Atlas.cmd again.\r\n5. GPT / Codex support is bundled. Claude and Grok official helpers are prepared automatically on first connection.\r\n\r\nCredentials and real quota data are never sent to Vercel.\r\n`);

execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", macApp], { stdio: "inherit" });
for (const path of [join(release, "Capacity-Atlas-Connector-macOS-arm64.zip"), join(release, "Capacity-Atlas-Connector-Windows-x64.zip")]) {
  await rm(path, { force: true });
}
execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", macApp, join(release, "Capacity-Atlas-Connector-macOS-arm64.zip")]);
execFileSync("ditto", ["-c", "-k", "--keepParent", windowsDir, join(release, "Capacity-Atlas-Connector-Windows-x64.zip")]);
await writeReleaseChecksums(release, [
  "Capacity-Atlas-Connector-Windows-x64.zip",
  "Capacity-Atlas-Connector-macOS-arm64.zip"
]);
console.log("Packaged macOS and Windows Connector archives in release/");
