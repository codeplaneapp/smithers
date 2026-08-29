terraform {
  required_version = ">= 1.9.0"

  required_providers {
    # The Docker provider runs the whole cache locally, with no cloud account.
    # Swapping the Postgres container for RDS or Cloud SQL is a provider
    # change here and a connection-string change in main.tf; nothing else in
    # the module depends on where Postgres runs.
    docker = {
      source  = "kreuzwerker/docker"
      version = "3.9.0"
    }
  }
}
