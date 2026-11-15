import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSimpleSaveRequest, simpleSavePayloadHash } from '../src/dashboardSimple/saveRequest.js';
import { draft, id, rule } from './fixtures/dashboard-simple/contracts.mjs';

function request() {
  return { requestId: id(20), requestIssuedAt: '2026-10-30T12:00:00.000Z', resolvedPeriod: { dateFrom: '2026-10-01', dateTo: '2026-10-30', timeZone: 'UTC' }, previewToken: 'signed', input: {
    contractVersion: 1, context: { kind: 'legacyDashboard', period: { dateFrom: '2026-10-01', dateTo: '2026-10-30', timeZone: 'UTC' } },
    draftRef: { draftId: id(1), draftVersion: 1 }, draft: draft(), editTarget: null,
  } };
}
const hash = body => simpleSavePayloadHash({ userId: id(3), dashboardId: id(4), body });

test('save accepts the complete preview envelope and rejects forged wrapper fields and scalar coercion', () => {
  const body = request();
  assert.doesNotThrow(() => validateSimpleSaveRequest(body));
  for (const changed of [{ ...body, userId: id(3) }, { ...body, requestId: 123 }, { ...body, previewToken: null }, { ...body, input: { ...body.input, draftRef: { draftId: id(1), draftVersion: '1' } } }]) {
    assert.throws(() => validateSimpleSaveRequest(changed));
  }
});

test('canonical replay hash excludes the proof and retry key, while retaining time, target, content and resolved period', () => {
  const body = request();
  assert.equal(hash(body), hash({ ...body, previewToken: 'rotated-proof', requestId: id(21) }));
  assert.equal(hash(body), hash({ ...body, requestIssuedAt: '2026-10-30T13:00:00.000+01:00' }));
  for (const changed of [{ ...body, requestIssuedAt: '2026-10-30T12:00:00.001Z' }, { ...body, resolvedPeriod: { ...body.resolvedPeriod, dateFrom: '2026-10-02' } }, { ...body, input: { ...body.input, editTarget: { widgetId: id(30), expectedWidgetRevision: 1 } } }, { ...body, input: { ...body.input, draft: { ...body.input.draft, title: 'Changed' } } }]) assert.notEqual(hash(body), hash(changed));
  assert.notEqual(hash(body), simpleSavePayloadHash({ userId: id(3), dashboardId: id(5), body }));
});

test('canonical hash sorts set-like athletes and explicit rule priorities without treating numeric strings as numbers', () => {
  const body = request();
  body.input.draft.athleteSelection = { mode: 'selected', athleteIds: [id(7), id(8)] };
  body.input.draft.presentation = { mode: 'replace', value: { schemaVersion: 1, tableFormatting: { evaluationVersion: 1, rules: [rule(), { ...rule(), id: 'second', priority: 2 }] } } };
  const reordered = structuredClone(body);
  reordered.input.draft.athleteSelection.athleteIds.reverse();
  reordered.input.draft.presentation.value.tableFormatting.rules.reverse();
  assert.equal(hash(body), hash(reordered));
  reordered.input.draft.presentation.value.tableFormatting.rules[0].threshold.value = '2000';
  assert.notEqual(hash(body), hash(reordered));
});
