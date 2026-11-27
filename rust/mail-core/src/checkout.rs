//! Finds this PC's checkout of the repo a peer's message names (the cross-pc-ssh rules).
//!
//! The peer sends only what identifies a repo: its root commits and normalized origin. The owner
//! lists the folders whose direct children may be checkouts (`checkout_roots` in policy.json). A
//! checkout matches when it shares a root commit; only full clones count (linked worktrees,
//! junctions or symlinks and shallow clones are skipped), and the origin decides between several.
//! A single match whose origin differs is refused as a probable fork. Nothing here makes a network
//! call: GitHub renames are the owner's `origin_aliases`, and peer strings are only compared, never
//! used to build a path.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CACHE_FILE: &str = "checkouts.json";
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// What identifies a repo across PCs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoId {
    /// Root commit hashes (lowercase hex).
    pub roots: Vec<String>,
    /// `host/owner/name`, as [`norm_origin`] returns it.
    pub origin: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Repo,
    Worktree,
    Link,
}

/// One direct child of a checkout root that has a `.git`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub path: PathBuf,
    pub kind: Kind,
    pub roots: Vec<String>,
    pub origin: Option<String>,
    pub shallow: bool,
}

/// Why no checkout was chosen. The text is for the ledger and the owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unresolved {
    NoRoots,
    NoMatch { skipped: Vec<PathBuf> },
    Ambiguous(Vec<PathBuf>),
    Fork { path: PathBuf, origin: String },
}

impl std::fmt::Display for Unresolved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unresolved::NoRoots => write!(f, "no checkout_roots in policy.json"),
            Unresolved::NoMatch { skipped } => {
                write!(f, "no checkout of this repo under checkout_roots")?;
                for path in skipped {
                    write!(f, "; skipped {}", path.display())?;
                }
                Ok(())
            }
            Unresolved::Ambiguous(paths) => {
                write!(f, "several checkouts share this repo's history and origin did not decide:")?;
                for path in paths {
                    write!(f, " {}", path.display())?;
                }
                Ok(())
            }
            Unresolved::Fork { path, origin } => write!(
                f,
                "the only checkout sharing this history has another origin ({origin}): {}; it is probably a fork, so it is not used",
                path.display()
            ),
        }
    }
}

/// `git@github.com:Owner/Name.git`, `https://github.com/owner/name` and
/// `ssh://git@github.com/owner/name.git` all become `github.com/owner/name`. Other shapes are `None`.
pub fn norm_origin(url: &str) -> Option<String> {
    use std::sync::OnceLock;
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    static SCP: OnceLock<regex::Regex> = OnceLock::new();
    let url = url.trim();
    let url_re = URL.get_or_init(|| {
        regex::Regex::new(r"^(?:ssh|https?|git)://(?:[^@/]+@)?([\w.-]+)(?::\d+)?/(.+)$").unwrap()
    });
    let scp_re = SCP.get_or_init(|| regex::Regex::new(r"^[\w.-]+@([\w.-]+):(.+)$").unwrap());
    let caps = url_re.captures(url).or_else(|| scp_re.captures(url))?;
    let mut path = caps[2].trim_matches('/');
    if let Some(stripped) = path.strip_suffix(".git") {
        path = stripped;
    }
    if path.matches('/').count() != 1 || path.split('/').any(str::is_empty) {
        return None;
    }
    Some(format!(
        "{}/{}",
        caps[1].to_lowercase(),
        path.to_lowercase()
    ))
}

/// The origin an alias maps to, so a renamed repo still matches its old name.
fn canon<'a>(origin: &'a str, aliases: &'a BTreeMap<String, String>) -> &'a str {
    aliases.get(origin).map(String::as_str).unwrap_or(origin)
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    // Lowercased everywhere, as cross-pc-ssh does: two checkouts differing only by case are one.
    text.trim_end_matches(['\\', '/']).to_lowercase()
}

/// Picks the one candidate that is this repo.
pub fn choose(
    want: &RepoId,
    candidates: &[Candidate],
    aliases: &BTreeMap<String, String>,
) -> Result<PathBuf, Unresolved> {
    let roots: BTreeSet<&str> = want.roots.iter().map(String::as_str).collect();
    let mut seen = BTreeSet::new();
    let mut matches: Vec<&Candidate> = Vec::new();
    let mut near = Vec::new();
    for candidate in candidates {
        if !candidate
            .roots
            .iter()
            .any(|root| roots.contains(root.as_str()))
        {
            continue;
        }
        if candidate.kind != Kind::Repo || candidate.shallow {
            near.push(candidate.path.clone());
            continue;
        }
        if seen.insert(path_key(&candidate.path)) {
            matches.push(candidate);
        }
    }
    let same_origin = |candidate: &Candidate, mine: &str| {
        candidate
            .origin
            .as_deref()
            .is_some_and(|theirs| canon(theirs, aliases) == canon(mine, aliases))
    };
    if let (true, Some(mine)) = (matches.len() > 1, want.origin.as_deref()) {
        let same: Vec<&Candidate> = matches
            .iter()
            .copied()
            .filter(|candidate| same_origin(candidate, mine))
            .collect();
        if !same.is_empty() {
            matches = same;
        }
    }
    match matches.as_slice() {
        [] => Err(Unresolved::NoMatch { skipped: near }),
        [only] => match (want.origin.as_deref(), only.origin.as_deref()) {
            (Some(mine), Some(theirs)) if !same_origin(only, mine) => Err(Unresolved::Fork {
                path: only.path.clone(),
                origin: theirs.to_owned(),
            }),
            _ => Ok(only.path.clone()),
        },
        several => Err(Unresolved::Ambiguous(
            several
                .iter()
                .map(|candidate| candidate.path.clone())
                .collect(),
        )),
    }
}

/// Runs a read-only git query about `dir` itself, killed after a few seconds, without a console
/// window. Discovery stops at `dir` (git never answers for an enclosing repo), and inherited
/// repository variables are cleared so they can't point git elsewhere.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).args(args);
    for variable in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
    ] {
        command.env_remove(variable);
    }
    if let Some(parent) = dir.parent() {
        command.env("GIT_CEILING_DIRECTORIES", parent);
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().ok()?;
    // Read while git runs, so a full pipe can't stall it until the time limit.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        std::io::Read::read_to_string(&mut stdout, &mut out).map(|_| out)
    });
    let started = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() <= GIT_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let out = reader.join().ok()?.ok()?;
    success.then_some(out)
}

/// True when git's work tree for `dir` is `dir` itself.
fn is_toplevel(dir: &Path) -> bool {
    let Some(top) = git(dir, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    match (
        std::fs::canonicalize(top.trim()),
        std::fs::canonicalize(dir),
    ) {
        (Ok(top), Ok(dir)) => path_key(&top) == path_key(&dir),
        _ => false,
    }
}

/// The identity of the checkout at `dir`, or `None` when git can't read it.
pub fn identify(dir: &Path) -> Option<RepoId> {
    if !is_toplevel(dir) {
        return None;
    }
    let mut roots: Vec<String> = git(dir, &["rev-list", "--max-parents=0", "HEAD"])?
        .lines()
        .map(|line| line.trim().to_lowercase())
        .filter(|line| !line.is_empty())
        .collect();
    roots.sort();
    roots.dedup();
    if roots.is_empty() {
        return None;
    }
    let origin = git(dir, &["remote", "get-url", "origin"]).and_then(|url| norm_origin(&url));
    Some(RepoId { roots, origin })
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// Classifies one folder. `None` when it has no `.git` or git can't read it.
pub fn candidate(path: &Path) -> Option<Candidate> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    let dot_git = path.join(".git");
    let kind = if is_link(&meta) {
        Kind::Link
    } else if dot_git.is_dir() {
        Kind::Repo
    } else if dot_git.is_file() {
        Kind::Worktree
    } else {
        return None;
    };
    if kind == Kind::Link && !dot_git.exists() {
        return None;
    }
    let shallow = dot_git.join("shallow").is_file();
    let id = identify(path)?;
    Some(Candidate {
        path: path.to_path_buf(),
        kind,
        roots: id.roots,
        origin: id.origin,
        shallow,
    })
}

/// Every direct child of the roots that has a `.git`. A root is never itself a candidate.
pub fn scan(roots: &[PathBuf]) -> Vec<Candidate> {
    let mut found = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        children.sort();
        found.extend(children.iter().filter_map(|child| candidate(child)));
    }
    found
}

/// The sender's side (ADR 0006 decision 1): the identity of the repo that holds `dir`, as envelope
/// 1.3 `checkout` carries it. `None` outside a git checkout. No path leaves this function, and the
/// folder name is left out when it is the OS user name (a repo at the profile folder).
pub fn local_checkout(dir: &Path) -> Option<crate::envelope::Checkout> {
    let env = |name: &str| std::env::var(name).ok();
    let user = first_set(&["USERNAME", "USER"], env);
    let home = first_set(&["USERPROFILE", "HOME"], env).map(PathBuf::from);
    local_checkout_as(dir, user.as_deref(), home.as_deref())
}

/// The first of `names` whose value is set and not blank: an empty `USERNAME` doesn't hide `USER`.
fn first_set(names: &[&str], lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    names
        .iter()
        .find_map(|name| lookup(name).filter(|value| !value.trim().is_empty()))
}

/// `local_checkout` with the OS user name and home folder passed in, for tests.
pub(crate) fn local_checkout_as(
    dir: &Path,
    user: Option<&str>,
    home: Option<&Path>,
) -> Option<crate::envelope::Checkout> {
    let top = dir
        .ancestors()
        .find(|folder| folder.join(".git").exists())?;
    let id = identify(top)?;
    let hash = |value: Option<String>| {
        value
            .map(|value| value.trim().to_lowercase())
            .filter(|value| {
                matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
            })
    };
    // A repo at the profile folder would send the user's folder name, whatever it is called.
    let at_home =
        home.is_some_and(
            |home| match (std::fs::canonicalize(top), std::fs::canonicalize(home)) {
                (Ok(top), Ok(home)) => path_key(&top) == path_key(&home),
                _ => false,
            },
        );
    let name = top
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|_| !at_home)
        .filter(|name| user.is_none_or(|user| !name.eq_ignore_ascii_case(user.trim())));
    // The roots alone must be valid; each optional part is kept only if it fits the envelope's
    // limits on its own, so one bad part never costs the others.
    let mut checkout = crate::envelope::Checkout {
        roots: id.roots.into_iter().take(4).collect(),
        origin: None,
        head: None,
        branch: None,
        name: None,
    };
    if !checkout.is_valid() {
        return None;
    }
    let branch = git(top, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map(|branch| branch.trim().to_owned())
        .filter(|branch| !branch.is_empty());
    let head = hash(git(top, &["rev-parse", "HEAD"]));
    let keep = |checkout: &mut crate::envelope::Checkout,
                set: &dyn Fn(&mut crate::envelope::Checkout)| {
        let mut trial = checkout.clone();
        set(&mut trial);
        if trial.is_valid() {
            *checkout = trial;
        }
    };
    keep(&mut checkout, &|c| c.origin = id.origin.clone());
    keep(&mut checkout, &|c| c.head = head.clone());
    keep(&mut checkout, &|c| c.branch = branch.clone());
    keep(&mut checkout, &|c| c.name = name.clone());
    Some(checkout)
}

#[derive(Default, Serialize, Deserialize)]
struct Cache {
    #[serde(default)]
    checkouts: BTreeMap<String, PathBuf>,
}

/// Resolves repo identities against the owner's roots, caching each answer in `<home>/checkouts.json`.
/// A cached path is used only after it still passes [`choose`] on its own.
pub struct Resolver<'a> {
    pub home: &'a Path,
    pub roots: &'a [PathBuf],
    pub aliases: &'a BTreeMap<String, String>,
}

impl Resolver<'_> {
    fn key(&self, want: &RepoId) -> String {
        let mut roots = want.roots.clone();
        roots.sort();
        let origin = want
            .origin
            .as_deref()
            .map(|origin| canon(origin, self.aliases))
            .unwrap_or("");
        hex::encode(Sha256::digest(
            format!("{}|{origin}", roots.join(",")).as_bytes(),
        ))
    }

    fn load(&self) -> Cache {
        std::fs::read_to_string(self.home.join(CACHE_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save(&self, cache: &Cache) {
        let path = self.home.join(CACHE_FILE);
        let temp = self.home.join(format!("{CACHE_FILE}.tmp"));
        if let Ok(text) = serde_json::to_string_pretty(cache) {
            if std::fs::write(&temp, text).is_ok() {
                let _ = std::fs::rename(&temp, &path);
            }
        }
    }

    pub fn resolve(&self, want: &RepoId) -> Result<PathBuf, Unresolved> {
        if self.roots.is_empty() {
            return Err(Unresolved::NoRoots);
        }
        let key = self.key(want);
        let mut cache = self.load();
        if let Some(path) = cache.checkouts.get(&key) {
            // A plain folder name directly under a root: never `..`, `.` or a drive or root prefix.
            let plain_name = matches!(
                path.components().next_back(),
                Some(std::path::Component::Normal(_))
            );
            let under_root = plain_name
                && self.roots.iter().any(|root| {
                    path.parent()
                        .is_some_and(|parent| path_key(parent) == path_key(root))
                });
            if under_root {
                if let Some(found) = candidate(path) {
                    if let Ok(path) = choose(want, &[found], self.aliases) {
                        return Ok(path);
                    }
                }
            }
        }
        let chosen = choose(want, &scan(self.roots), self.aliases);
        match &chosen {
            Ok(path) => {
                cache.checkouts.insert(key, path.clone());
            }
            Err(_) => {
                cache.checkouts.remove(&key);
            }
        }
        self.save(&cache);
        chosen
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.invalid",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} in {}", dir.display());
    }

    fn repo(dir: &Path, origin: Option<&str>) {
        repo_with(dir, origin, "root");
    }

    /// Root commits hash the message and the time, so unrelated test repos need distinct messages.
    fn repo_with(dir: &Path, origin: Option<&str>, message: &str) {
        std::fs::create_dir_all(dir).unwrap();
        run(dir, &["init", "-q"]);
        run(dir, &["commit", "-q", "--allow-empty", "-m", message]);
        if let Some(origin) = origin {
            run(dir, &["remote", "add", "origin", origin]);
        }
    }

    fn clone(from: &Path, to: &Path, origin: &str) {
        run(
            from.parent().unwrap(),
            &[
                "clone",
                "-q",
                &from.to_string_lossy(),
                &to.to_string_lossy(),
            ],
        );
        run(to, &["remote", "set-url", "origin", origin]);
    }

    fn none() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    #[test]
    fn origins_normalize_across_url_shapes() {
        for url in [
            "git@github.com:Owner/Name.git",
            "https://github.com/owner/name",
            "ssh://git@GitHub.com:22/owner/name.git/",
        ] {
            assert_eq!(
                norm_origin(url).as_deref(),
                Some("github.com/owner/name"),
                "{url}"
            );
        }
        assert_eq!(norm_origin("https://github.com/only"), None);
        assert_eq!(norm_origin("C:\\Repos\\name"), None);
    }

    #[test]
    fn matches_a_clone_and_skips_worktrees_links_and_shallow_copies() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        repo(&src, Some("git@github.com:o/app.git"));
        let roots = dir.path().join("roots");
        std::fs::create_dir_all(&roots).unwrap();
        let app = roots.join("app");
        clone(&src, &app, "https://github.com/o/app");
        run(
            &app,
            &[
                "worktree",
                "add",
                "-q",
                &roots.join("app-wt").to_string_lossy(),
            ],
        );
        let shallow = roots.join("shallow");
        clone(&src, &shallow, "https://github.com/o/app");
        std::fs::write(shallow.join(".git").join("shallow"), "").unwrap();
        let link = roots.join("link");
        #[cfg(windows)]
        let linked = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&app)
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&app, &link).is_ok();
        assert!(linked, "made a link to the clone");

        let want = identify(&src).unwrap();
        let found = scan(std::slice::from_ref(&roots));
        let kinds: BTreeMap<String, (Kind, bool)> = found
            .iter()
            .map(|c| {
                (
                    c.path.file_name().unwrap().to_string_lossy().into_owned(),
                    (c.kind, c.shallow),
                )
            })
            .collect();
        assert_eq!(kinds["app"], (Kind::Repo, false));
        assert_eq!(kinds["app-wt"], (Kind::Worktree, false));
        assert_eq!(kinds["link"], (Kind::Link, false));
        assert_eq!(kinds["shallow"], (Kind::Repo, true));
        assert_eq!(choose(&want, &found, &none()), Ok(app.clone()));
    }

    fn cand(path: &str, roots: &[&str], origin: Option<&str>) -> Candidate {
        Candidate {
            path: PathBuf::from(path),
            kind: Kind::Repo,
            roots: roots.iter().map(|r| r.to_string()).collect(),
            origin: origin.map(str::to_owned),
            shallow: false,
        }
    }

    #[test]
    fn origin_decides_between_several_and_a_lone_fork_is_refused() {
        let want = RepoId {
            roots: vec!["aa".into()],
            origin: Some("github.com/o/app".into()),
        };
        let mine = cand("C:\\r\\app", &["aa"], Some("github.com/o/app"));
        let fork = cand("C:\\r\\fork", &["aa", "bb"], Some("github.com/x/app"));
        let other = cand("C:\\r\\other", &["cc"], Some("github.com/o/app"));
        assert_eq!(
            choose(&want, &[mine.clone(), fork.clone(), other], &none()),
            Ok(mine.path.clone())
        );
        assert_eq!(
            choose(&want, std::slice::from_ref(&fork), &none()),
            Err(Unresolved::Fork {
                path: fork.path.clone(),
                origin: "github.com/x/app".into()
            })
        );
        let aliases =
            BTreeMap::from([("github.com/x/app".to_owned(), "github.com/o/app".to_owned())]);
        assert_eq!(
            choose(&want, std::slice::from_ref(&fork), &aliases),
            Ok(fork.path.clone()),
            "renamed repo"
        );
        let no_origin = RepoId {
            roots: vec!["aa".into()],
            origin: None,
        };
        assert_eq!(
            choose(&no_origin, std::slice::from_ref(&fork), &none()),
            Ok(fork.path.clone())
        );
    }

    #[test]
    fn duplicates_collapse_and_ambiguity_and_no_match_are_refused() {
        let want = RepoId {
            roots: vec!["aa".into()],
            origin: Some("github.com/o/app".into()),
        };
        let a = cand("C:\\r\\app", &["aa"], Some("github.com/o/app"));
        let same = cand("c:\\R\\APP\\", &["aa"], Some("github.com/o/app"));
        assert_eq!(
            choose(&want, &[a.clone(), same], &none()),
            Ok(a.path.clone())
        );
        let b = cand("C:\\r\\app2", &["aa"], Some("github.com/o/app"));
        assert_eq!(
            choose(&want, &[a.clone(), b.clone()], &none()),
            Err(Unresolved::Ambiguous(vec![a.path.clone(), b.path.clone()]))
        );
        let mut wt = cand("C:\\r\\wt", &["aa"], None);
        wt.kind = Kind::Worktree;
        assert_eq!(
            choose(
                &want,
                &[wt.clone(), cand("C:\\r\\x", &["zz"], None)],
                &none()
            ),
            Err(Unresolved::NoMatch {
                skipped: vec![wt.path]
            })
        );
    }

    #[test]
    fn the_cache_is_revalidated_before_use() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let src = dir.path().join("src");
        repo(&src, Some("https://github.com/o/app"));
        let roots = vec![dir.path().join("roots")];
        std::fs::create_dir_all(&roots[0]).unwrap();
        let app = roots[0].join("app");
        clone(&src, &app, "https://github.com/o/app");
        let want = identify(&src).unwrap();
        let aliases = none();
        let resolver = Resolver {
            home: &home,
            roots: &roots,
            aliases: &aliases,
        };
        assert_eq!(resolver.resolve(&want), Ok(app.clone()));
        assert!(home.join(CACHE_FILE).is_file(), "the answer is cached");

        // The cached folder now holds another repo: the cache must not be trusted.
        std::fs::remove_dir_all(&app).unwrap();
        repo_with(&app, Some("https://github.com/o/app"), "an unrelated repo");
        let moved = roots[0].join("moved");
        clone(&src, &moved, "https://github.com/o/app");
        assert_eq!(
            resolver.resolve(&want),
            Ok(moved),
            "rescanned after the cached path stopped matching"
        );

        let empty: Vec<PathBuf> = Vec::new();
        let unrooted = Resolver {
            home: &home,
            roots: &empty,
            aliases: &aliases,
        };
        assert_eq!(unrooted.resolve(&want), Err(Unresolved::NoRoots));
    }

    #[test]
    fn a_child_inside_another_repo_does_not_borrow_its_identity() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().join("outer");
        repo_with(&outer, Some("https://github.com/o/outer"), "outer root");
        let roots = outer.join("roots");
        std::fs::create_dir_all(roots.join("child").join(".git")).unwrap();
        assert_eq!(
            candidate(&roots.join("child")),
            None,
            "an empty .git is not a repo"
        );
        assert!(scan(std::slice::from_ref(&roots)).is_empty());
    }

    #[test]
    fn a_cached_path_outside_the_roots_is_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let src = dir.path().join("src");
        repo(&src, Some("https://github.com/o/app"));
        // The roots folder sits inside a clone of the same repo, so its parent would match.
        let outer = dir.path().join("outer");
        clone(&src, &outer, "https://github.com/o/app");
        let roots = vec![outer.join("roots")];
        std::fs::create_dir_all(&roots[0]).unwrap();
        let app = roots[0].join("app");
        clone(&src, &app, "https://github.com/o/app");
        let want = identify(&src).unwrap();
        let aliases = none();
        let resolver = Resolver {
            home: &home,
            roots: &roots,
            aliases: &aliases,
        };
        for bogus in [roots[0].join(".."), outer.clone()] {
            let cache = Cache {
                checkouts: BTreeMap::from([(resolver.key(&want), bogus.clone())]),
            };
            resolver.save(&cache);
            assert_eq!(
                resolver.resolve(&want),
                Ok(app.clone()),
                "rescanned instead of using {}",
                bogus.display()
            );
        }
    }

    #[test]
    fn local_checkout_names_the_repo_from_any_subfolder() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("my-app");
        repo(&app, Some("git@github.com:Owner/My-App.git"));
        let sub = app.join("src").join("deep");
        std::fs::create_dir_all(&sub).unwrap();
        let checkout = local_checkout(&sub).unwrap();
        assert_eq!(checkout.roots, identify(&app).unwrap().roots);
        assert_eq!(checkout.origin.as_deref(), Some("github.com/owner/my-app"));
        assert_eq!(checkout.name.as_deref(), Some("my-app"));
        assert!(checkout.head.as_deref().is_some_and(|h| h.len() == 40));
        assert!(checkout.branch.is_some());
        assert!(checkout.is_valid());
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(local_checkout(plain.path()), None, "not a checkout");
    }

    #[test]
    fn the_folder_name_is_left_out_when_it_is_the_os_user_name() {
        let dir = tempfile::tempdir().unwrap();
        let home_repo = dir.path().join("alice");
        repo(&home_repo, Some("https://github.com/alice/dotfiles"));
        let as_alice = local_checkout_as(&home_repo, Some("Alice"), None).unwrap();
        assert_eq!(
            as_alice.name, None,
            "a repo at the profile folder doesn't send the user name"
        );
        assert_eq!(
            as_alice.origin.as_deref(),
            Some("github.com/alice/dotfiles"),
            "the rest is kept"
        );
        let as_bob = local_checkout_as(&home_repo, Some("bob"), None).unwrap();
        assert_eq!(as_bob.name.as_deref(), Some("alice"));
    }

    #[test]
    fn one_invalid_part_does_not_cost_the_others() {
        let dir = tempfile::tempdir().unwrap();
        // A folder name with a space fails the name limit; the branch and origin are fine.
        let app = dir.path().join("my app");
        repo(&app, Some("https://github.com/o/app"));
        run(&app, &["checkout", "-q", "-b", "feature/x"]);
        let checkout = local_checkout_as(&app, None, None).unwrap();
        assert_eq!(checkout.name, None);
        assert_eq!(
            checkout.branch.as_deref(),
            Some("feature/x"),
            "kept although the name was dropped"
        );
        assert_eq!(checkout.origin.as_deref(), Some("github.com/o/app"));
        assert!(checkout.head.is_some());
    }

    #[test]
    fn a_repo_at_the_home_folder_sends_no_name_whatever_the_folder_is_called() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("alice.DESKTOP-1");
        repo(&profile, Some("https://github.com/alice/dotfiles"));
        let at_home = local_checkout_as(&profile, Some("alice"), Some(&profile)).unwrap();
        assert_eq!(
            at_home.name, None,
            "the profile folder's name is the user's"
        );
        assert_eq!(at_home.origin.as_deref(), Some("github.com/alice/dotfiles"));
        let elsewhere = local_checkout_as(&profile, Some("alice"), Some(dir.path())).unwrap();
        assert_eq!(elsewhere.name.as_deref(), Some("alice.DESKTOP-1"));
    }

    #[test]
    fn an_invalid_origin_is_dropped_and_the_branch_name_and_head_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        // Normalizes to github.com/o/a+b, which the envelope's origin limit refuses.
        repo(&app, Some("https://github.com/o/a+b"));
        run(&app, &["checkout", "-q", "-b", "feature/x"]);
        let checkout = local_checkout_as(&app, None, None).unwrap();
        assert_eq!(checkout.origin, None);
        assert_eq!(checkout.branch.as_deref(), Some("feature/x"));
        assert_eq!(checkout.name.as_deref(), Some("app"));
        assert!(checkout.head.is_some());
    }

    #[test]
    fn a_blank_variable_does_not_hide_the_next_one() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(
            first_set(
                &["USERNAME", "USER"],
                env(&[("USERNAME", " "), ("USER", "alice")])
            )
            .as_deref(),
            Some("alice")
        );
        assert_eq!(
            first_set(
                &["USERNAME", "USER"],
                env(&[("USERNAME", ""), ("USER", "alice")])
            )
            .as_deref(),
            Some("alice")
        );
        assert_eq!(
            first_set(
                &["USERNAME", "USER"],
                env(&[("USERNAME", "bob"), ("USER", "alice")])
            )
            .as_deref(),
            Some("bob")
        );
        assert_eq!(
            first_set(&["USERNAME", "USER"], env(&[("USERNAME", " ")])),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_home_folder_matches_however_its_path_is_spelled() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("Profile");
        repo(&profile, Some("https://github.com/alice/dotfiles"));
        let spelled = PathBuf::from(format!("{}\\", profile.to_string_lossy().to_uppercase()));
        assert_eq!(
            local_checkout_as(&profile, None, Some(&spelled))
                .unwrap()
                .name,
            None
        );
    }
}
