#!/usr/bin/env node
// Keep this order: restoration must precede environment-reading dependencies.
import "./bootstrap.ts";
import "./register-oauth.ts";
import "./register-bedrock.ts";
import "../cli.ts";
