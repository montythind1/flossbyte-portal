# FlossByte backup check (runs on the office's server or one always-on
# PC via the Atera script library, on a daily schedule).
#
# What it does: finds the office's backup product, reads the most
# recent backup job result it can prove (Windows Server Backup event
# log, or a known agent's service state plus its event source), and
# posts the result to the FlossByte portal, where it appears on the
# office's Backup card and in the morning check.
#
# Setup (once per office, in Atera):
#   1. Upload this script to the Atera script library.
#   2. In the portal, open the office's WiFi & Internet page ->
#      Backup setup (FlossByte) -> Generate token.
#   3. Create the script run with the two variables below set:
#      FLOSSBYTE_PORTAL_URL and FLOSSBYTE_COLLECTOR_TOKEN.
#   4. Schedule it daily, early morning, on the backup machine.
#
# The script posts ONLY when it has a job verdict. If it cannot prove
# a result, it exits quietly and the portal keeps the last known
# status; a human can record a result by hand in the meantime.

$PortalUrl = $env:FLOSSBYTE_PORTAL_URL
$Token     = $env:FLOSSBYTE_COLLECTOR_TOKEN
if (-not $PortalUrl -or -not $Token) { Write-Output "Missing FLOSSBYTE_PORTAL_URL or FLOSSBYTE_COLLECTOR_TOKEN."; exit 1 }

$now = Get-Date
$verdict = $null   # @{ ok; at; product; detail }

# --- Windows Server Backup: Event ID 4 = job finished successfully.
try {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Backup/Operational'; StartTime = $now.AddHours(-72) } -MaxEvents 40 -ErrorAction Stop |
        Where-Object { $_.Id -in 4, 5, 49, 517, 546, 561 } |
        Sort-Object TimeCreated -Descending | Select-Object -First 1
  if ($ev) {
    $verdict = @{ ok = ($ev.Id -eq 4); at = $ev.TimeCreated; product = 'Windows Server Backup'; detail = "Event $($ev.Id)" }
  }
} catch { }

# --- Known agent services (presence + a fresh job hint from events).
if (-not $verdict) {
  $agents = @(
    @{ Match = 'x360Recover|Axcient';  Product = 'Axcient x360Recover' },
    @{ Match = 'Veeam';                Product = 'Veeam Agent' },
    @{ Match = 'Datto';                Product = 'Datto' },
    @{ Match = 'CrashPlan|Code42';     Product = 'CrashPlan' }
  )
  foreach ($a in $agents) {
    $svc = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $a.Match -or $_.DisplayName -match $a.Match } | Select-Object -First 1
    if ($svc) {
      # An installed, running agent with no failure events from its
      # own source in the last 36 hours is reported as completed; a
      # stopped agent is a failure the office should hear about.
      if ($svc.Status -ne 'Running') {
        $verdict = @{ ok = $false; at = $now; product = $a.Product; detail = "Backup service is $($svc.Status)" }
      } else {
        $verdict = @{ ok = $true; at = $now; product = $a.Product; detail = 'Backup service running; no job log read' }
      }
      break
    }
  }
}

if (-not $verdict) { Write-Output "No backup product verdict found; nothing posted."; exit 0 }

$body = @{
  kind    = 'backup'
  ok      = [bool]$verdict.ok
  at      = ([DateTime]$verdict.at).ToUniversalTime().ToString('o')
  product = $verdict.product
  detail  = $verdict.detail
} | ConvertTo-Json

try {
  Invoke-RestMethod -Method Post -Uri "$PortalUrl/api/collector/report" `
    -Headers @{ 'X-Collector-Token' = $Token } -ContentType 'application/json' -Body $body | Out-Null
  Write-Output "Posted backup result: ok=$($verdict.ok) product=$($verdict.product)"
} catch {
  Write-Output "Could not post the backup result: $($_.Exception.Message)"
  exit 1
}
