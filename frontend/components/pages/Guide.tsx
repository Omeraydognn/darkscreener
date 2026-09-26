import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, Clock3, EyeOff, KeyRound, LockKeyhole, Newspaper, Rocket, ShieldCheck } from "lucide-react";

const STEPS = [
  { icon: ArrowDownToLine, title: "Para yatır", body: "Gizli hesabın sana özel bir yatırma adresi verir. Oraya MON gönder; gelen MON otomatik olarak gizli dolar bakiyene (dUSD, 1 dUSD = 1 $) çevrilir. Cüzdan bağlaman gerekmez." },
  { icon: Newspaper, title: "Projeyi araştır", body: "Canlı fiyat yok. Karar verirken projenin anlattıklarına ve kayıtlı anahtarıyla imzaladığı haberlere bakarsın. Fiyat geçmişi yalnızca 7 gün gecikmeli görünür." },
  { icon: EyeOff, title: "Gizli al", body: "Yalnızca dolar tutarını girersin. Emrin tarayıcında şifrelenir, sıfır bilgi kanıtıyla relayer üzerinden gönderilir. Zincirde ne tutar, ne yön, ne de proje görünür." },
  { icon: Clock3, title: "7 gün bekle", body: "Aynı penceredeki tüm emirler enclave'de tek fiyattan eşleşir. Sonuç drand zaman kilidiyle 7 gün kilitlenir; kimse, enclave bile erken açamaz. Sonra kaç token aldığını görürsün." },
  { icon: LockKeyhole, title: "Gizli sat", body: "Satarken miktar değil yüzde seçersin (%25, %50, %75, %100 ya da başka). Satış geliri de 7 gün sonra açılır ve nakit bakiyene eklenir." },
  { icon: ArrowUpFromLine, title: "Gazsız çek", body: "Nakit bakiyeni istediğin adrese MON (ya da dUSD) olarak çekersin. Gazı relayer öder; alıcı adres, yatırma adresinle ilişkilendirilemez." },
];

const VISIBILITY: [string, string, string][] = [
  ["Canlı fiyat ve hacim", "Hiç kimse", "7 gün sonra, toplam olarak"],
  ["Kimin ne aldığı", "Hiç kimse", "Hiçbir zaman (yalnızca sen)"],
  ["Aldığın token miktarı", "Hiç kimse", "7 gün sonra yalnızca sen"],
  ["Yatırma / çekme tutarı", "Herkes (zincirde)", "Birbirine ve işlemlerine bağlanamaz"],
  ["Proje haberleri", "Herkes", "Anında, imzalı"],
];

export function Guide() {
  return (
    <div className="mx-auto grid max-w-5xl gap-8">
      <section className="page-intro">
        <div>
          <span className="mini-eyebrow">NASIL ÇALIŞIR?</span>
          <h1>Fiyatı gizle, projeyi göster.</h1>
          <p>Fenomen hesapların ve balinaların canlı grafik üzerinden fiyat manipülasyonunu anlamsız kılmak için tasarlandı.</p>
        </div>
      </section>

      <ol className="guide-steps">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="panel-box">
            <span className="step-no">{String(i + 1).padStart(2, "0")}</span>
            <Icon size={20} />
            <h2>{title}</h2>
            <p>{body}</p>
          </li>
        ))}
      </ol>

      <section className="panel-box" aria-labelledby="vis-h">
        <div className="panel-title"><span id="vis-h"><ShieldCheck size={16} /> Kim neyi, ne zaman görür?</span></div>
        <table className="explore-table">
          <thead><tr><th>Bilgi</th><th>İşlem anında</th><th>Sonra</th></tr></thead>
          <tbody>{VISIBILITY.map(([a, b, c]) => <tr key={a}><td>{a}</td><td>{b}</td><td>{c}</td></tr>)}</tbody>
        </table>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="panel-box p-5">
          <h2 className="flex items-center gap-2 font-semibold"><KeyRound size={16} /> Hesabın ve yedeğin</h2>
          <p className="mt-2 text-muted">Gizli hesabın bir anahtardır ve yalnızca tarayıcında durur. Portföy sayfasından yedeğini indir; tarayıcı verisi silinirse yedeksiz erişemezsin. İstersen tarayıcı cüzdanının imzasıyla da giriş yapabilirsin; aynı imza her seferinde aynı hesabı açar.</p>
        </div>
        <div className="panel-box p-5">
          <h2 className="flex items-center gap-2 font-semibold"><ShieldCheck size={16} /> Güvenlik</h2>
          <p className="mt-2 text-muted">Kontrat; enclave imzasını, emir ve havuz zincirlerini, durum zincirini doğrular. Settlement 2 gün durursa kaçış kapağı fonlarını enclave olmadan iade eder. Testnet sürümünde MON kuru demo değeridir ve token&apos;lar değersizdir.</p>
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <Link href="/" className="btn-primary">Projeleri keşfet</Link>
        <Link href="/launch" className="btn-secondary"><Rocket size={15} /> Token oluştur</Link>
      </div>
    </div>
  );
}
