'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const exists = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
function expand(p) { return path.resolve(p.replace(/^~(?=[/\\]|$)/, os.homedir()).replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`)); }
function resolveFolder(p) {
  const expanded=expand(p);
  try { return fs.realpathSync.native(expanded); } catch { return expanded; }
}
function environment(key) {
  if (process.env[key]) return process.env[key];
  if (process.platform === 'win32') {
    try {
      const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      return execFileSync(shell,['-NoProfile','-NonInteractive','-Command',`[Environment]::GetEnvironmentVariable('${key}','User')`],{encoding:'utf8',windowsHide:true,timeout:3000}).trim();
    } catch { }
  }
  if (process.platform === 'darwin') {
    try { return execFileSync('/bin/launchctl', ['getenv', key], {encoding:'utf8', timeout:2000}).trim(); } catch { }
  }
  return '';
}
function appPresent(name) {
  if (process.platform === 'darwin') return ['/Applications', path.join(os.homedir(),'Applications')].some(root => exists(path.join(root,`${name}.app`)));
  const local = process.env.LOCALAPPDATA || '';
  if (exists(path.join(local,'Programs',name)) || exists(path.join(process.env.APPDATA || '',name))) return true;
  try { return fs.readdirSync(path.join(local,'Packages')).some(item => item.toLowerCase().startsWith(name.toLowerCase()+'_')); } catch { return false; }
}
function findProvider(provider, override) {
  const codex = provider === 'codex';
  const variable = codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const fromEnvironment = environment(variable);
  const defaultHome = path.join(os.homedir(),codex ? '.codex' : '.claude');
  const child = codex ? 'sessions' : '';
  const candidates = [];
  function add(home, origin) {
    if (!home) return;
    const folder = resolveFolder(child ? path.join(home, child) : home);
    if (!candidates.some(item => item.folder === folder)) candidates.push({folder, origin, exists:exists(folder)});
  }
  if (override) candidates.push({folder:resolveFolder(override), origin:'Your selected folder', exists:exists(resolveFolder(override))});
  add(fromEnvironment,variable);
  add(defaultHome,'User profile');
  if (process.platform === 'darwin') add(path.join(os.homedir(),'Library','Application Support',codex?'Codex':'Claude',codex?'.codex':'.claude'),'Application support');
  // Explicit overrides and environment roots remain authoritative, even when missing.
  const selected = override || fromEnvironment ? candidates[0] : candidates.find(item => item.exists) || candidates[0];
  const installed = appPresent(codex ? 'Codex' : 'Claude');
  return {...selected, detected:selected.exists || installed, appInstalled:installed, candidates};
}
function discover(settings) {
  return {codex:findProvider('codex',settings.codexSessionsOverride), claude:findProvider('claude',settings.claudeHomeOverride)};
}
module.exports = {discover, expand};
