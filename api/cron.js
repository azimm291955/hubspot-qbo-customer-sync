// HubSpot -> QuickBooks customer builder, on a Vercel cron.
//
// Sales asks for a customer by @-mentioning the finance owner in a HubSpot note
// ("@finance build this customer, Net 30"). Each run this job:
//   1. finds new request notes since the last run,
//   2. reads the company and contacts the note is attached to,
//   3. reuses the QuickBooks customer if one already exists for that license
//      number, otherwise creates it with the requested payment terms,
//   4. replies on the same HubSpot record with what it did,
//   5. follows up on requests it could not finish last time.
// Nothing is created when DRY_RUN=1; it only reports what it would do.
import { put, list } from '@vercel/blob';

const HS = 'https://api.hubapi.com';
const QBO = 'https://quickbooks.api.intuit.com/v3/company';
const OAUTH = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const STATE_KEY = 'customer-builder/state.json';
const DRY = process.env.DRY_RUN === '1';

// ---- state (last run, pending follow-ups, rotating QBO refresh token) ----
async function loadState() {
  const { blobs } = await list({ prefix: STATE_KEY });
  if (!blobs.length) return { since: Date.now() - 86400000, pending: [], refreshToken: process.env.QBO_REFRESH_TOKEN_SEED };
  return (await fetch(blobs[0].url)).json();
}
async function saveState(state) {
  await put(STATE_KEY, JSON.stringify(state), { access: 'public', addRandomSuffix: false, allowOverwrite: true });
}

// ---- HubSpot ----
async function hs(path, body) {
  const res = await fetch(HS + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HubSpot ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const mentions = (html, ownerId) => html.includes(`data-at-mention-id="${ownerId}"`) || html.includes(`data-owner-id="${ownerId}"`);
const isBuildRequest = text => /\b(build|create|set ?up)\b.*\bcustomer\b/i.test(text);

async function searchRequestNotes(since) {
  const out = await hs('/crm/v3/objects/notes/search', {
    filterGroups: [{ filters: [{ propertyName: 'hs_createdate', operator: 'GT', value: String(since) }] }],
    properties: ['hs_note_body', 'hs_createdate', 'hubspot_owner_id'],
    sorts: [{ propertyName: 'hs_createdate', direction: 'ASCENDING' }],
    limit: 100,
  });
  return out.results.filter(n => {
    const body = n.properties.hs_note_body || '';
    return mentions(body, process.env.AZ_OWNER_ID) && isBuildRequest(body.replace(/<[^>]+>/g, ' '));
  });
}
async function assocIds(noteId, toType) {
  const out = await hs(`/crm/v4/objects/notes/${noteId}/associations/${toType}`);
  return out.results.map(r => r.toObjectId);
}
async function batchRead(type, ids, properties) {
  if (!ids.length) return [];
  const out = await hs(`/crm/v3/objects/${type}/batch/read`, { inputs: ids.map(id => ({ id })), properties });
  return out.results;
}
async function ownerName(ownerId) {
  const o = await hs(`/crm/v3/owners/${ownerId}`);
  return [o.firstName, o.lastName].filter(Boolean).join(' ') || 'there';
}
async function postReply(companyId, html) {
  if (DRY) return console.log(`[dry run] reply on company ${companyId}: ${html}`);
  const note = await hs('/crm/v3/objects/notes', {
    properties: { hs_note_body: html, hs_timestamp: new Date().toISOString() },
  });
  await hs(`/crm/v4/objects/notes/${note.id}/associations/default/companies/${companyId}`, undefined)
    .catch(() => hs(`/crm/v3/objects/notes/${note.id}/associations/companies/${companyId}/note_to_company`));
}

// ---- parsing the request ----
const findEmails = text => [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [])];
function findTerms(text) {
  const m = text.match(/\b(net\s*\d{1,3}|due on receipt|cod)\b/i);
  if (!m) return null;
  const t = m[1].toLowerCase().replace(/\s+/g, ' ');
  if (t === 'cod') return 'COD';
  if (t === 'due on receipt') return 'Due on receipt';
  return 'Net ' + t.replace(/\D/g, '');
}
const cleanName = s => String(s || '').replace(/\s+/g, ' ').replace(/[^\w &'.,-]/g, '').trim().slice(0, 100);

// ---- QuickBooks ----
async function qboToken(state) {
  const res = await fetch(OAUTH, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: state.refreshToken }),
  });
  if (!res.ok) throw new Error(`QBO auth: ${res.status}`);
  const t = await res.json();
  state.refreshToken = t.refresh_token;            // QuickBooks rotates it on every use
  return t.access_token;
}
async function qbo(token, path, body) {
  const res = await fetch(`${QBO}/${process.env.QBO_REALM_ID}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`QBO ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
const query = (token, sql) => qbo(token, `query?query=${encodeURIComponent(sql)}`);

// One customer per state license number: the license, not the name, is the key.
async function findCustomerByLicence(token, licence) {
  if (!licence) return null;
  const out = await query(token, `select Id, DisplayName, Notes from Customer where Active = true maxresults 1000`);
  return (out.QueryResponse.Customer || []).find(c => (c.Notes || '').includes(licence)) || null;
}
async function termId(token, name) {
  if (!name) return null;
  const out = await query(token, `select Id, Name from Term where Name = '${name.replace(/'/g, "\\'")}'`);
  return out.QueryResponse.Term?.[0]?.Id || null;
}

// ---- one request ----
async function handleNote(note, token) {
  const text = (note.properties.hs_note_body || '').replace(/<[^>]+>/g, ' ');
  const [companyId] = await assocIds(note.id, 'companies');
  if (!companyId) return { status: 'pending', why: 'note is not attached to a company' };

  const [company] = await batchRead('companies', [companyId], ['name', 'license_number', 'address', 'city', 'state', 'zip', 'phone']);
  const contacts = await batchRead('contacts', await assocIds(note.id, 'contacts'), ['email', 'firstname', 'lastname']);
  const p = company.properties;
  const who = await ownerName(note.properties.hubspot_owner_id);

  const existing = await findCustomerByLicence(token, p.license_number);
  if (existing) {
    await postReply(companyId, `Hi ${who}, ${existing.DisplayName} is already in QuickBooks (customer ${existing.Id}). Nothing new was created.`);
    return { status: 'done', customerId: existing.Id, created: false };
  }

  const missing = [!p.name && 'company name', !p.license_number && 'license number'].filter(Boolean);
  if (missing.length) {
    await postReply(companyId, `Hi ${who}, I can't build this customer yet. Missing: ${missing.join(', ')}. I'll try again on the next run.`);
    return { status: 'pending', why: `missing ${missing.join(', ')}` };
  }

  const terms = findTerms(text);
  const emails = [...findEmails(text), ...contacts.map(c => c.properties.email).filter(Boolean)];
  const customer = {
    DisplayName: cleanName(p.name),
    CompanyName: cleanName(p.name),
    Notes: `License ${p.license_number}`,
    PrimaryEmailAddr: emails[0] ? { Address: emails[0] } : undefined,
    PrimaryPhone: p.phone ? { FreeFormNumber: p.phone } : undefined,
    BillAddr: { Line1: p.address, City: p.city, CountrySubDivisionCode: p.state, PostalCode: p.zip },
  };
  const tid = await termId(token, terms);
  if (tid) customer.SalesTermRef = { value: tid };
  if (DRY) {
    console.log('[dry run] would create', customer);
    return { status: 'done', created: false, dryRun: true };
  }
  const { Customer } = await qbo(token, 'customer', customer);
  await postReply(companyId, `Hi ${who}, ${Customer.DisplayName} is set up in QuickBooks (customer ${Customer.Id})${terms ? ` on ${terms}` : ''}.`);
  return { status: 'done', customerId: Customer.Id, created: true };
}

async function followUps(state, token) {
  const still = [];
  for (const id of state.pending) {
    const [note] = await batchRead('notes', [id], ['hs_note_body', 'hubspot_owner_id']);
    const r = note ? await handleNote(note, token) : { status: 'done' };
    if (r.status === 'pending') still.push(id);
  }
  state.pending = still;
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const state = await loadState();
  const token = await qboToken(state);
  const started = Date.now();
  const results = [];

  await followUps(state, token);
  for (const note of await searchRequestNotes(state.since)) {
    try {
      const r = await handleNote(note, token);
      if (r.status === 'pending' && !state.pending.includes(note.id)) state.pending.push(note.id);
      results.push({ note: note.id, ...r });
    } catch (e) {
      results.push({ note: note.id, status: 'error', why: e.message });
      if (!state.pending.includes(note.id)) state.pending.push(note.id);
    }
  }
  state.since = started;
  await saveState(state);
  res.status(200).json({ dryRun: DRY, processed: results.length, pending: state.pending.length, results });
}
