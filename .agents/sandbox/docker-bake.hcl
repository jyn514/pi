target "base" {
  context = ".agents/sandbox"
  dockerfile = "Dockerfile"
  tags = ["pi-sandbox-base:local"]
}
