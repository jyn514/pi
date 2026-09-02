#!/usr/bin/env node
// Keep this order: restoration must precede environment-reading dependencies.
import "./sandbox-env-setup.ts";
import "./register-oauth.ts";
import "./register-bedrock.ts";
import "./register-quickjs.ts";
import "../cli.ts";
