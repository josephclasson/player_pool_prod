$ErrorActionPreference = "Stop"
$path = "C:\Users\josep\Desktop\player-pool\StatTracker - 2025 Player Pool.xlsx"

function Get-ColLetter([int]$col){
  $letters = ""
  $n = $col
  while($n -gt 0){
    $m = ($n - 1) % 26
    $letters = ([char](65 + $m)) + $letters
    $n = [int](($n - 1) / 26)
  }
  return $letters
}

$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
$wb = $xl.Workbooks.Open($path)
$ws = $wb.Worksheets.Item("StatTracker")

$range = $ws.Range("A1:Z140")
$vals = $range.Value2
$rows = $vals.GetLength(0)
$cols = $vals.GetLength(1)

$keywords = @("round","r1","r2","r3","r4","team","total","totals","points")
$items = New-Object System.Collections.Generic.List[object]

for($r=1; $r -le $rows; $r++){
  for($c=1; $c -le $cols; $c++){
    $v = $vals[$r,$c]
    if($null -ne $v){
      $s = $v.ToString().Trim()
      if($s -ne "" -and $s -match "[A-Za-z]"){
        $coord = (Get-ColLetter $c) + $r
        $match = $false
        foreach($k in $keywords){
          if($s.ToLower().Contains($k)) { $match = $true; break }
        }
        $items.Add([pscustomobject]@{coord=$coord;row=$r;col=$c;text=$s;keyword=$match})
      }
    }
  }
}

$items = $items | Sort-Object row,col
"Found text-like cells: {0}" -f $items.Count
"--- keyword-like (first 200) ---"
$matchItems = $items | Where-Object {$_.keyword -eq $true} | Select-Object -First 200
foreach($it in $matchItems){ Write-Output ($it.coord + ' | ' + $it.text) }

"--- sample text-like (first 60) ---"
$sample = $items | Select-Object -First 60
foreach($it in $sample){ Write-Output ($it.coord + ' | ' + $it.text) }

$wb.Close($false)
$xl.Quit()
[void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($ws)
[void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb)
[void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($xl)
