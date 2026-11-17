import { serverAddress } from './direct.mjs';
import { Account, api } from './account-client.mjs';
const $ = id => document.getElementById(id);
const account = new Account();
let accountBusy = false;
function view() {
  const saved = location.hash === '#account';
  $('connect').hidden = saved; $('account').hidden = !saved;
  $('direct-tab').setAttribute('aria-current', saved ? 'false' : 'page');
  $('account-tab').setAttribute('aria-current', saved ? 'page' : 'false');
}
window.addEventListener('hashchange', view);
view();
function destination(input) {
  const url = serverAddress(input);
  if (new URL(url).hostname === location.hostname) throw new Error('Enter your community server’s address. This public portal does not host chat servers.');
  return url;
}
function review(input) {
  const url = destination(input);
  $('destination-text').textContent = url;
  $('continue').href = url;
  location.hash = 'connect'; view();
  $('destination-review').hidden = false;
  $('review-button').classList.remove('primary');
  $('direct-status').textContent = '';
}
$('destination').addEventListener('input', () => {
  $('destination-review').hidden = true; $('continue').removeAttribute('href'); $('review-button').classList.add('primary');
});
$('direct-form').addEventListener('submit', event => {
  event.preventDefault();
  try { review($('destination').value); $('continue').focus(); }
  catch (error) { $('review-button').classList.add('primary'); $('destination-review').hidden = true; $('direct-status').textContent = error.message; }
});
function render() {
  const unlocked = !!account.key && !!account.list;
  $('auth-form').hidden = unlocked; $('unlocked').hidden = !unlocked;
  $('servers').replaceChildren();
  if (!unlocked) return;
  $('vault-state').textContent = account.list.servers.length ? 'List unlocked in this tab. Each server still needs its own login.' : 'List unlocked in this tab. Add your first server address below.';
  account.list.servers.forEach((url, i) => {
    const li = document.createElement('li');
    const text = document.createElement('span'); text.textContent = url; text.dir = 'ltr'; li.append(text);
    const connect = document.createElement('button'); connect.type = 'button'; connect.textContent = 'Review connection';
    connect.addEventListener('click', () => { $('destination').value = url; review(url); $('continue').focus(); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove ' + url);
    remove.addEventListener('click', () => run(async () => { await account.save({ format: 1, servers: account.list.servers.filter((_, n) => n !== i) }); render(); $('account-status').textContent = 'Address removed from the encrypted list.'; $('saved-address').focus(); }));
    li.append(connect, remove); $('servers').append(li);
  });
}
async function run(work) {
  if (accountBusy) return;
  accountBusy = true; $('account').setAttribute('aria-busy', 'true');
  $('account').querySelectorAll('button').forEach(button => { button.disabled = true; });
  $('account-status').textContent = 'Working…';
  try { await work(); }
  catch (error) {
    if (error.status === 401 || error.code === 'account_changed') { account.clear(); render(); }
    if (error.code === 'account_changed') {
      for (const id of ['username', 'password', 'saved-address', 'delete-confirm']) $(id).value = '';
      $('username').focus();
    }
    $('account-status').textContent = error.message || 'Request failed. Retry or connect directly.';
  }
  finally { accountBusy = false; $('account').removeAttribute('aria-busy'); $('account').querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
$('auth-form').addEventListener('submit', event => {
  event.preventDefault(); const signup = event.submitter?.value === 'signup';
  let password = $('password').value; $('password').value = '';
  run(async () => {
    try { await account.authenticate($('username').value, password, signup); render(); $('account-status').textContent = 'Encrypted list unlocked. Reloading this page requires login again.'; $('saved-address').focus(); }
    finally { password = ''; }
  });
});
$('add-form').addEventListener('submit', event => {
  event.preventDefault(); run(async () => {
    const url = destination($('saved-address').value);
    if (account.list.servers.includes(url)) throw new Error('That address is already saved.');
    await account.save({ format: 1, servers: [...account.list.servers, url] });
    $('saved-address').value = ''; render(); $('account-status').textContent = 'Address encrypted and saved.';
  });
});
$('reload').addEventListener('click', () => run(async () => { await account.load(); render(); $('account-status').textContent = 'Latest saved list loaded.'; }));
$('export').addEventListener('click', () => {
  if (!account.list) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(account.list, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'housecall-servers.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('account-status').textContent = 'Plaintext download requested. Keep the file private.';
});
$('logout').addEventListener('click', () => run(async () => {
  let failed = false;
  try { await account.logout(); } catch { failed = true; }
  render(); $('account-status').textContent = failed ? 'List locked in this tab. Server logout could not be confirmed. Retry logout below; the server session expires within 30 minutes.' : 'Logged out. Encrypted list locked.';
  $('retry').textContent = failed ? 'Retry server logout' : 'Check service again'; $('retry').dataset.logout = failed ? 'yes' : '';
  $('username').focus();
}));
$('reauth').addEventListener('click', () => { account.clear(); render(); $('account-status').textContent = 'List locked in this tab. Log in again to reauthenticate.'; $('username').focus(); });
$('delete-form').addEventListener('submit', event => {
  event.preventDefault(); if ($('delete-confirm').value !== 'DELETE') return;
  run(async () => { await account.delete(); $('delete-confirm').value = ''; render(); $('account-status').textContent = 'HouseCall account and saved list deleted. Your server accounts are unchanged.'; $('username').focus(); });
});
async function status() {
  try {
    const result = await api('/status');
    $('account-status').textContent = result.registrationOpen ? 'Account service available. Log in or create an account.' : 'Registration is closed pending review. Existing accounts can log in. Direct connection is available.';
  } catch { $('account-status').textContent = 'Account service unavailable. Retry below. Direct connection is available.'; }
}
$('retry').addEventListener('click', () => run(async () => {
  if ($('retry').dataset.logout === 'yes') { await api('/logout', {}); $('retry').dataset.logout = ''; $('retry').textContent = 'Check service again'; $('account-status').textContent = 'Server logout confirmed.'; }
  else await status();
}));
window.addEventListener('pagehide', () => { account.clear(); $('password').value = ''; $('saved-address').value = ''; $('destination').value = ''; $('destination-review').hidden = true; $('continue').removeAttribute('href'); render(); });
render(); status();
