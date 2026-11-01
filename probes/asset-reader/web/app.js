import createPakModule from './generated/pak_reader.mjs';
import { inspectSmallModel } from './model.js';
import { inspectTexture } from './texture.js';
import { inspectXt } from './xt.js';
import { inspectReferenceLevel } from './level.js';
import { MAX_ASSET_BYTES, decodeAsset } from './packet.js';

const el = id => document.getElementById(id);
const LIMIT = 64 * 1024 * 1024;
const state = { module: null, entries: [], generation: 0, busy: false };
const bytes = n => n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(2)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`;
function status(message, error = false) { el('status').textContent = message; el('status').classList.toggle('error', error); }
function setBusy(value) { state.busy = value; el('file').disabled = value || !state.module; el('reference').disabled = value || !state.module; el('level-reference').disabled=value||!state.module; el('level-sample').disabled=value; el('package').disabled=value; }

function inspect(data, fileSize) {
  const mod = state.module;
  const ptr = mod._malloc(Math.max(1, data.length));
  if (!ptr) throw new Error('WebAssembly belleği ayrılamadı.');
  let result = 0;
  try {
    mod.HEAPU8.set(data, ptr);
    result = mod._pak_inspect(ptr, data.length, fileSize);
    if (!result) throw new Error('Paket okuyucu sonuç döndürmedi.');
    return JSON.parse(mod.UTF8ToString(result));
  } finally {
    if (result) mod._pak_free(result);
    mod._free(ptr);
  }
}

async function loadSource(source) {
  const generation = ++state.generation;
  state.assetController?.abort();
  setBusy(true); el('result').hidden = true; el('model-result').hidden = true; el('texture-result').hidden=true; el('xt-result').hidden=true;
  try {
    if (!Number.isSafeInteger(source.size) || source.size < 1) throw new Error('Dosya boyutu geçersiz.');
    let length = Math.min(64, source.size);
    for (let attempt = 0; attempt < 8; attempt++) {
      status(`${source.name}: ${bytes(length)} indeks bölümü okunuyor…`);
      const data = new Uint8Array(await source.readPrefix(length));
      if (generation !== state.generation) return;
      if (data.length !== length) throw new Error('Dosya okuması beklenenden kısa döndü.');
      const report = inspect(data, source.size);
      if (report.status === 'need_more') {
        const next = report.requiredBytes;
        if (!Number.isSafeInteger(next) || next <= length || next > source.size || next > LIMIT) throw new Error('İndeks boyutu desteklenen sınırların dışında.');
        length = next;
        continue;
      }
      if (report.status !== 'ok') throw new Error(report.error || report.message || 'Paket biçimi desteklenmiyor.');
      renderReport(source, report, length);
      return report;
    }
    throw new Error('Paket indeksi okuma adımı sınırı aşıldı.');
  } catch (error) { status(error.message, true); throw error; }
  finally { if (generation === state.generation) setBusy(false); }
}

function renderReport(source, report, readSize) {
  state.source = source; state.header = report.header;
  state.entries = report.entries || [];
  const header = report.header;
  el('filename').textContent = source.name;
  el('format').textContent = `PAK v${header.version} · ${header.endian}`;
  el('file-size').textContent = bytes(source.size);
  el('read-size').textContent = bytes(readSize);
  el('entry-count').textContent = state.entries.length.toLocaleString('tr-TR');
  el('codec').textContent = header.codecName || String(header.codec);
  el('filter').value = '';
  el('result').hidden = false;
  renderEntries();
  status(`İndeks WebAssembly ile okundu. Dosyanın %${(readSize / source.size * 100).toFixed(3)} bölümü belleğe alındı.`);
  window.dispatchEvent(new CustomEvent('pak-inspected', { detail: report }));
}

function renderEntries() {
  const term = el('filter').value.toLocaleLowerCase('en-US');
  const filtered = state.entries.filter(entry => (entry.path || '').toLocaleLowerCase('en-US').includes(term));
  el('match-count').textContent = `${filtered.length.toLocaleString('tr-TR')} kayıt`;
  const fragment = document.createDocumentFragment();
  for (const entry of filtered.slice(0, 300)) {
    const row = document.createElement('tr');
    const values = [entry.path || `#${entry.index}`, entry.isDirectory ? 'Klasör' : 'Dosya', bytes(entry.logicalBytes), entry.dataOffset == null ? '—' : entry.dataOffset.toLocaleString('tr-TR')];
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    const model=entry.path.endsWith('.model'),texture=entry.path.endsWith('.texture'),xt=entry.path.endsWith('.xt');
    const supported=(model||texture)?state.header.codec===4&&state.header.fatEntryType===0:xt&&[1,2,4].includes(state.header.codec)&&[0,1].includes(state.header.fatEntryType);
    if (!entry.isDirectory && supported && entry.logicalBytes > 0 && entry.logicalBytes <= MAX_ASSET_BYTES && entry.physicalBytes > 0 && entry.physicalBytes <= MAX_ASSET_BYTES+131072 && state.source.readRange) {
      const action = document.createElement('button'); action.textContent = xt?'Şemayı oku':texture?'Dokuyu aç':'Blokları oku'; action.className = 'row-action';
      action.addEventListener('click', async () => {
        state.assetController?.abort(); const controller=new AbortController();state.assetController=controller;
        action.disabled=true;
        try {
          if(xt){
            const source=state.source,codec=state.header.codec;
            const packed=new Uint8Array(await source.readRange(entry.dataOffset,entry.physicalBytes));
            const decoded=await decodeAsset(packed,entry.logicalBytes,codec,{signal:controller.signal});
            controller.signal.throwIfAborted();inspectXt(state.module,decoded,entry);
          }else await (texture?inspectTexture:inspectSmallModel)(state.module,state.source,entry,{signal:controller.signal});
        }
        catch(error){if(error.name!=='AbortError')status(error.message,true);}
        finally{action.disabled=false;}
      });
      row.firstChild.append(' ', action);
    }
    fragment.append(row);
  }
  if (filtered.length > 300) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = 'İlk 300 kayıt gösteriliyor. Daha dar bir arama yapabilirsiniz.'; row.append(cell); fragment.append(row); }
  el('entries').replaceChildren(fragment);
}

el('filter').addEventListener('input', renderEntries);
el('file').addEventListener('change', () => {
  const file = el('file').files[0];
  if (file) loadSource({ name: file.name, size: file.size, readPrefix: n => file.slice(0, n).arrayBuffer(), readRange: (offset, length) => file.slice(offset, offset + length).arrayBuffer() }).catch(() => {});
  el('file').value = '';
});
el('reference').addEventListener('click', () => loadReference().catch(error => status(error.message, true)));
el('level-reference').addEventListener('click',async()=>{
  state.assetController?.abort();const controller=new AbortController();state.assetController=controller;
  setBusy(true);
  try{await inspectReferenceLevel(state.module,{signal:controller.signal});}
  catch(error){if(error.name!=='AbortError')el('level-status').textContent=error.message;}
  finally{setBusy(false);}
});

async function loadReference() {
  const name = encodeURIComponent(el('package').value);
  const response = await fetch(`/reference/info?pak=${name}`);
  if (!response.ok) throw new Error('Yerel referans dosyası bulunamadı.');
  const info = await response.json();
  return loadSource({ name: info.name, size: info.size, readPrefix: async n => {
    const result = await fetch(`/reference/prefix?pak=${name}&bytes=${n}`);
    if (!result.ok) throw new Error('Yerel referans verisi okunamadı.');
    return result.arrayBuffer();
  }, readRange: async (offset, length) => {
    const result = await fetch(`/reference/range?pak=${name}&offset=${offset}&bytes=${length}`);
    if (!result.ok) throw new Error('Model verisi okunamadı.');
    return result.arrayBuffer();
  } });
}

try {
  state.module = await createPakModule();
  el('runtime').textContent = 'WebAssembly hazır'; el('runtime').classList.add('ready');
  setBusy(false); status('Bir paket seçerek başlayın veya kurulu oyunun boot.pak dosyasını deneyin.');
  if (new URLSearchParams(location.search).get('reference') === '1') await loadReference().catch(error => status(error.message, true));
} catch (error) { el('runtime').textContent = 'Modül yüklenemedi'; status(error.message, true); }
