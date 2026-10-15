# sanalyer: manifest.json -> latest belgesi (Updater.ts fetchManualLatest / DownloadRedirects latest.json)
{
  version: .version,
  pub_date: .pub_date,
  files: (.files | with_entries(.value = {url: ($base + "/" + .value.filename), sha256: .value.sha256}))
}
