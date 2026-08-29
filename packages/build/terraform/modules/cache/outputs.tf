output "endpoint" {
  description = "The cache root to hand RemoteCacheStore.layer and RemoteArtifacts.layer."
  value       = "http://127.0.0.1:${var.listen_port}"
}

output "database_url" {
  description = "Connection string for the cache schema, for migrations and inspection."
  value       = local.database_url
  sensitive   = true
}

output "postgres_container" {
  description = "Name of the Postgres container, for psql and pg_dump."
  value       = docker_container.postgres.name
}
