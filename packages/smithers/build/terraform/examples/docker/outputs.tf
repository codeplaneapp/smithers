output "endpoint" {
  description = "Cache root for RemoteCacheStore.layer and RemoteArtifacts.layer."
  value       = module.cache.endpoint
}

output "postgres_container" {
  description = "Postgres container name, for psql and pg_dump."
  value       = module.cache.postgres_container
}
