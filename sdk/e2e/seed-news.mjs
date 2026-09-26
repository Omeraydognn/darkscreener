// Proje haberlerini geçmiş tarihlerle (ör. 7 günlük gizli dönemin farklı günlerine) yerleştirir.
//
//   NEWS_KEYS=.testnet/news-keys.json NEWS_FILE=.testnet/news.jsonl node sdk/e2e/seed-news.mjs scripts/news.seed.json
//
// Relayer API'si yalnızca "şimdi" tarihli haber kabul eder (±10 dk); bu araç her haberi yine
// projenin kayıtlı anahtarıyla, kendi tarihiyle imzalar ve haber kaydına doğrudan yazar.
// Relayer kaydı açılışta okur: çalıştırdıktan sonra relayer'ı yeniden başlatın.
// Dosyadaki havuzların önceki haberleri kaldırılır (eski kayıt .bak dosyasına yedeklenir).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { message } from "../src/news.mjs";

const seedFile = process.argv[2];
const keysFile = process.env.NEWS_KEYS;
const newsFile = process.env.NEWS_FILE;
if (!seedFile || !keysFile || !newsFile) {
  console.error("kullanım: NEWS_KEYS=... NEWS_FILE=... node sdk/e2e/seed-news.mjs <haberler.json>");
  process.exit(2);
}

const keys = JSON.parse(readFileSync(keysFile, "utf8"));
const items = JSON.parse(readFileSync(seedFile, "utf8"));
const pools = new Set(items.map((i) => String(i.poolId)));
const now = Math.floor(Date.now() / 1000);

const old = existsSync(newsFile) ? readFileSync(newsFile, "utf8").split("\n").filter((l) => l.trim()) : [];
if (old.length) copyFileSync(newsFile, `${newsFile}.bak-${now}`);
const kept = old.filter((l) => !pools.has(String(JSON.parse(l).poolId)));

const lines = [];
for (const it of items) {
  const key = keys[String(it.poolId)];
  if (!key) throw new Error(`havuz #${it.poolId} için haber anahtarı yok (${keysFile})`);
  if (!(it.daysAgo > 0 && it.daysAgo < 7)) throw new Error(`"${it.title}": daysAgo 0 ile 7 arasında olmalı (gizli dönem)`);
  const signer = privateKeyToAccount(key);
  const timestamp = now - Math.round(it.daysAgo * 86_400);
  const url = it.url ?? "";
  const signature = await signer.signMessage({ message: message(it.poolId, timestamp, it.title, it.body, url) });
  lines.push(JSON.stringify({ poolId: it.poolId, title: it.title, body: it.body, url, timestamp, signature, signer: signer.address }));
  console.log(`#${it.poolId} · ${new Date(timestamp * 1000).toLocaleString("tr-TR")} · ${it.title}`);
}

writeFileSync(newsFile, [...kept, ...lines].join("\n") + "\n");
console.log(`${lines.length} haber yazıldı (${old.length - kept.length} eski haber kaldırıldı). Relayer'ı yeniden başlatın.`);
