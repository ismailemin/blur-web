// Decoded PC FLSK metadata only. Payload objects and actor state are not imported.
const MAX_BYTES = 64 * 1024 * 1024;
const ROW_LIMIT = 300;
const BEHAVIOURS = ['Atom', 'Enum', 'Flags', 'Struct'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('tr-TR') : '—';

export function inspectXtBytes(mod, decoded) {
  if (!(decoded instanceof Uint8Array) || decoded.byteLength < 72 || decoded.byteLength > MAX_BYTES) {
    throw new Error('XT verisi desteklenen 72 bayt–64 MiB sınırlarının dışında.');
  }
  if (typeof mod?._xt_inspect !== 'function' || typeof mod?._xt_free !== 'function') {
    throw new Error('XT WebAssembly okuyucusu henüz derlenmedi.');
  }
  const pointer = mod._malloc(decoded.byteLength);
  if (!pointer) throw new Error('XT belleği ayrılamadı.');
  let output = 0;
  try {
    mod.HEAPU8.set(decoded, pointer);
    output = mod._xt_inspect(pointer, decoded.byteLength);
    if (!output) throw new Error('XT okuyucusu sonuç döndürmedi.');
    const report = JSON.parse(mod.UTF8ToString(output));
    if (report.status !== 'ok') throw new Error(report.error || 'XT metadata okunamadı.');
    return report;
  } finally {
    if (output) mod._xt_free(output);
    mod._free(pointer);
  }
}

function rows(target, values) {
  const fragment = document.createDocumentFragment();
  for (const valuesForRow of values.slice(0, ROW_LIMIT)) {
    const row = document.createElement('tr');
    for (const value of valuesForRow) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.append(cell);
    }
    fragment.append(row);
  }
  if (values.length > ROW_LIMIT) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = values[0]?.length || 1;
    cell.textContent = `İlk ${ROW_LIMIT} satır gösteriliyor; toplam ${count(values.length)} kayıt.`;
    row.append(cell);
    fragment.append(row);
  }
  target.replaceChildren(fragment);
}

export function inspectXt(mod, decoded, entry) {
  const element = id => document.getElementById(id);
  const panel = element('xt-result');
  const status = element('xt-status');
  if (!panel || !status) throw new Error('XT sonuç paneli bulunamadı.');
  panel.hidden = false;
  element('xt-name').textContent = String(entry?.path || 'Yerel XT verisi').split(/[\\/]/).at(-1);
  status.textContent = 'XT şeması WebAssembly ile okunuyor…';
  for (const id of ['xt-tables', 'xt-types', 'xt-records']) element(id).replaceChildren();
  try {
    const report = inspectXtBytes(mod, decoded);
    const tables = report.tables || {};
    const types = report.types || [];
    const records = report.records || [];
    rows(element('xt-tables'), Object.entries(tables).map(([name, table]) => [
      name, count(table.offset), count(table.count), count(table.elementBytes),
    ]));
    rows(element('xt-types'), types.map(type => [
      count(type.index), type.name, BEHAVIOURS[type.behaviour] || `#${type.behaviour}`, count(type.size), count(type.fieldCount),
    ]));
    rows(element('xt-records'), records.map(record => [
      count(record.index), `0x${record.id.toString(16).padStart(8, '0')}`, types[record.typeIndex]?.name || `#${record.typeIndex}`,
      count(record.componentCount), count(record.dataBytes), count(record.stringBytes),
    ]));
    status.textContent = `FLSK v${report.version} · Şema sınırları doğrulandı: ${count(types.length)} tip, ${count(report.fields?.length || 0)} alan, ${count(records.length)} kayıt. Actor/runtime oluşturulmadı; kayıt içeriği ve imzalar doğrulanmadı.`;
    return report;
  } catch (error) {
    status.textContent = `XT okunamadı: ${error.message}`;
    throw error;
  }
}
