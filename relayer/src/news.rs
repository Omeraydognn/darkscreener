//! Proje meta verisi ve imzalı proje haberleri.
//!
//! Platformda canlı fiyat yok; kullanıcının gördüğü canlı bilgi PROJE GELİŞMELERİDİR. Bu yüzden
//! haberler yalnızca projenin kayıtlı anahtar(lar)ıyla imzalanmışsa kabul edilir — kimse
//! başka bir proje adına "haber" yayınlayıp manipülasyon yapamaz.
//!
//! İmza (EIP-191 personal_sign):
//! ```text
//! darkpool-news:v1
//! pool:<poolId>
//! ts:<unix saniye>
//! content:<keccak256(title || "\n" || body || "\n" || url) hex>
//! ```

use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, sync::Mutex};

use alloy::primitives::{keccak256, Address, Signature};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub symbol: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub website: String,
    #[serde(default)]
    pub twitter: String,
    #[serde(default)]
    pub telegram: String,
    #[serde(default)]
    pub discord: String,
    #[serde(default)]
    pub github: String,
    #[serde(default)]
    pub whitepaper: String,
    #[serde(default)]
    pub logo: String,
    #[serde(default)]
    pub category: String,
    /// Ekip, yol haritası, token dağılımı gibi uzun metinler (düz metin)
    #[serde(default)]
    pub team: String,
    #[serde(default)]
    pub roadmap: String,
    #[serde(default)]
    pub tokenomics: String,
    /// Haber imzalamaya yetkili adresler (projenin ekibi)
    #[serde(default)]
    pub news_signers: Vec<Address>,
}

impl Project {
    fn check(&self) -> Result<()> {
        ensure!(!self.name.trim().is_empty() && self.name.len() <= 48, "name length");
        ensure!(!self.symbol.trim().is_empty() && self.symbol.len() <= 11, "symbol length");
        for (field, v, max) in [
            ("description", &self.description, 4_000),
            ("team", &self.team, 4_000),
            ("roadmap", &self.roadmap, 4_000),
            ("tokenomics", &self.tokenomics, 4_000),
            ("category", &self.category, 40),
        ] {
            ensure!(v.len() <= max, "{field} too long");
        }
        for (field, v) in [
            ("website", &self.website),
            ("twitter", &self.twitter),
            ("telegram", &self.telegram),
            ("discord", &self.discord),
            ("github", &self.github),
            ("whitepaper", &self.whitepaper),
            ("logo", &self.logo),
        ] {
            ensure!(v.is_empty() || (v.starts_with("https://") && v.len() <= 200), "{field} must be an https URL");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsPost {
    pub pool_id: u32,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub url: String,
    pub timestamp: u64,
    pub signature: String,
    /// Sunucu doldurur (imzadan kurtarılan adres)
    #[serde(default)]
    pub signer: Option<Address>,
}

pub const MAX_TITLE: usize = 140;
pub const MAX_BODY: usize = 4_000;
const MAX_CLOCK_SKEW: u64 = 10 * 60;

pub fn message(pool_id: u32, ts: u64, title: &str, body: &str, url: &str) -> String {
    let content = keccak256(format!("{title}\n{body}\n{url}"));
    format!("darkpool-news:v1\npool:{pool_id}\nts:{ts}\ncontent:{content:#x}")
}

pub struct NewsStore {
    projects: Mutex<BTreeMap<u32, Project>>,
    projects_path: Option<PathBuf>,
    path: Option<PathBuf>,
    posts: Mutex<Vec<NewsPost>>,
}

impl NewsStore {
    /// `projects_file`: {"1": Project, ...}; `news_file`: JSON satırları (kalıcı kayıt).
    pub fn load(projects_file: Option<PathBuf>, news_file: Option<PathBuf>) -> Result<Self> {
        let projects: BTreeMap<u32, Project> = match &projects_file {
            Some(p) => serde_json::from_str(&fs::read_to_string(p).with_context(|| format!("{}", p.display()))?)?,
            None => BTreeMap::new(),
        };
        let mut posts = Vec::new();
        if let Some(p) = &news_file {
            if let Ok(text) = fs::read_to_string(p) {
                for line in text.lines().filter(|l| !l.trim().is_empty()) {
                    posts.push(serde_json::from_str(line)?);
                }
            }
        }
        Ok(Self { projects: Mutex::new(projects), projects_path: projects_file, path: news_file, posts: Mutex::new(posts) })
    }

    pub fn project(&self, pool_id: u32) -> Option<Project> {
        self.projects.lock().unwrap().get(&pool_id).cloned()
    }

    /// Launchpad ile açılmış bir projenin meta verisini kaydeder. `raw` (tam JSON metni) zincirdeki
    /// `metadataHash`'e eşit olmalıdır: meta veri açılış işlemine bağlıdır, sonradan kimse
    /// değiştiremez. Haber imzacısı zincirdeki `creator`'dır.
    pub fn register_launched(&self, pool_id: u32, raw: &str, metadata_hash: [u8; 32], creator: Address) -> Result<Project> {
        ensure!(raw.len() <= 20_000, "metadata too large");
        ensure!(keccak256(raw.as_bytes()).0 == metadata_hash, "metadata does not match on-chain metadataHash");
        let mut project: Project = serde_json::from_str(raw).context("metadata json")?;
        project.check()?;
        project.news_signers = vec![creator];
        let mut projects = self.projects.lock().unwrap();
        ensure!(!projects.contains_key(&pool_id), "project already registered");
        projects.insert(pool_id, project.clone());
        if let Some(path) = &self.projects_path {
            let tmp = path.with_extension("json.tmp");
            fs::write(&tmp, serde_json::to_vec_pretty(&*projects)?)?;
            fs::rename(tmp, path)?;
        }
        Ok(project)
    }

    pub fn verify(&self, post: &NewsPost, now: u64) -> Result<Address> {
        let project = self.project(post.pool_id).context("unknown project")?;
        ensure!(!post.title.trim().is_empty() && post.title.len() <= MAX_TITLE, "title length");
        ensure!(post.body.len() <= MAX_BODY, "body length");
        ensure!(post.url.is_empty() || post.url.starts_with("https://"), "url must be https");
        ensure!(post.timestamp.abs_diff(now) <= MAX_CLOCK_SKEW, "timestamp too far from server time");
        let sig: Signature = post.signature.parse().context("signature")?;
        let signer = sig.recover_address_from_msg(message(post.pool_id, post.timestamp, &post.title, &post.body, &post.url))?;
        if !project.news_signers.contains(&signer) {
            bail!("signer {signer} is not authorized for project {}", post.pool_id);
        }
        Ok(signer)
    }

    pub fn add(&self, mut post: NewsPost, now: u64) -> Result<NewsPost> {
        post.signer = Some(self.verify(&post, now)?);
        let mut posts = self.posts.lock().unwrap();
        ensure!(!posts.iter().any(|p| p.signature == post.signature), "duplicate post");
        if let Some(path) = &self.path {
            let mut f = fs::OpenOptions::new().create(true).append(true).open(path)?;
            writeln!(f, "{}", serde_json::to_string(&post)?)?;
        }
        posts.push(post.clone());
        Ok(post)
    }

    /// En yeniden eskiye.
    pub fn list(&self, pool: Option<u32>, limit: usize) -> Vec<NewsPost> {
        let posts = self.posts.lock().unwrap();
        let mut out: Vec<NewsPost> = posts.iter().filter(|p| pool.is_none_or(|id| p.pool_id == id)).cloned().collect();
        out.sort_by_key(|p| std::cmp::Reverse(p.timestamp));
        out.truncate(limit);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::signers::{local::PrivateKeySigner, SignerSync};

    fn store(signer: Address) -> NewsStore {
        let mut projects = BTreeMap::new();
        projects.insert(
            1,
            Project { name: "A".into(), symbol: "A".into(), news_signers: vec![signer], ..Default::default() },
        );
        NewsStore { projects: Mutex::new(projects), projects_path: None, path: None, posts: Mutex::new(vec![]) }
    }

    fn post(key: &PrivateKeySigner, pool: u32, ts: u64, title: &str) -> NewsPost {
        let sig = key.sign_message_sync(message(pool, ts, title, "body", "").as_bytes()).unwrap();
        NewsPost {
            pool_id: pool,
            title: title.into(),
            body: "body".into(),
            url: String::new(),
            timestamp: ts,
            signature: sig.to_string(),
            signer: None,
        }
    }

    #[test]
    fn only_project_signers_can_post() {
        let team = PrivateKeySigner::random();
        let stranger = PrivateKeySigner::random();
        let s = store(team.address());
        let now = 1_800_000_000;

        assert_eq!(s.add(post(&team, 1, now, "Mainnet tarihi"), now).unwrap().signer, Some(team.address()));
        assert!(s.add(post(&stranger, 1, now, "sahte"), now).is_err());
        assert!(s.add(post(&team, 2, now, "baska proje"), now).is_err());
        assert!(s.add(post(&team, 1, now - 3600, "eski"), now).is_err());

        let mut tampered = post(&team, 1, now, "orijinal");
        tampered.title = "degistirilmis".into();
        assert!(s.add(tampered, now).is_err());

        let p = post(&team, 1, now, "tekrar");
        assert!(s.add(p.clone(), now).is_ok());
        assert!(s.add(p, now).is_err());
        assert_eq!(s.list(Some(1), 10).len(), 2);
    }

    #[test]
    fn launched_metadata_must_match_chain_hash() {
        let s = store(Address::ZERO);
        let creator = Address::repeat_byte(7);
        let raw = r#"{"name":"ArfDAO","symbol":"ARF","website":"https://arfdao.dev"}"#;
        let hash = keccak256(raw.as_bytes()).0;
        assert!(s.register_launched(1000, raw, [0; 32], creator).is_err());
        let bad = r#"{"name":"X","symbol":"X","website":"http://insecure"}"#;
        assert!(s.register_launched(1001, bad, keccak256(bad.as_bytes()).0, creator).is_err());
        let p = s.register_launched(1000, raw, hash, creator).unwrap();
        assert_eq!(p.news_signers, vec![creator]);
        assert!(s.register_launched(1000, raw, hash, creator).is_err(), "no overwrite");
    }
}
