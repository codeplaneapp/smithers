terraform {
  required_version = ">= 1.9.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "3.9.0"
    }
  }
}

provider "docker" {
  # The default socket on Linux and on Docker Desktop for macOS. Point this at
  # a remote daemon to run the cache somewhere else.
  host = "unix:///var/run/docker.sock"
}
