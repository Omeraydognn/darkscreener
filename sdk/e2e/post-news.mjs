// Proje haberi yayınla: projenin kayıtlı haber anahtarıyla imzalar ve relayer'a gönderir.
//
//   NEWS_KEY=0x... RELAYER_URL=http://127.0.0.1:8090 node sdk/e2e/post-news.mjs <poolId> "<başlık>" "<metin>" [url]
//
// Anahtar yalnızca ortam değişkeninden okunur (komut satırına yazılmaz, loglanmaz).
import { privateKeyToAccount } from "viem/accounts";
import { message } from "../src/news.mjs";

const [poolIdArg, title, body = "", url = ""] = process.argv.slice(2);
const poolId = Number(poolIdArg);
if (!Number.isInteger(poolId) || poolId < 1 || !title) {
  console.error('kullanım: NEWS_KEY=... RELAYER_URL=... node sdk/e2e/post-news.mjs <poolId> "<başlık>" "<metin>" [url]');
  process.exit(2);
}
const key = process.env.NEWS_KEY;
if (!key) throw new Error("NEWS_KEY gerekli");
const relayer = process.env.RELAYER_URL ?? "http://127.0.0.1:8090";

const signer = privateKeyToAccount(key);
const timestamp = Math.floor(Date.now() / 1000);
const signature = await signer.signMessage({ message: message(poolId, timestamp, title, body, url) });
const res = await fetch(`${relayer}/v1/news`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ poolId, title, body, url, timestamp, signature }),
});
if (!res.ok) throw new Error(`relayer ${res.status}: ${await res.text()}`);
console.log(`yayınlandı: havuz #${poolId} · ${title} · imzacı ${signer.address}`);
