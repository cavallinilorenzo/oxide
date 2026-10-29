use super::{ModelEntry, err};
use crate::Result;
use std::{
    future::Future,
    io::{Cursor, Read},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

/// Network and disk boundary, injectable for offline lifecycle tests.
pub trait ModelSource: Send + Sync {
    fn available_space(&self, directory: &Path) -> Result<u64>;
    fn open(&self, entry: &ModelEntry, cancelled: Arc<AtomicBool>) -> Result<Box<dyn Read + Send>>;
}

pub(super) struct HttpSource;
impl ModelSource for HttpSource {
    fn available_space(&self, directory: &Path) -> Result<u64> {
        let path = dunce::canonicalize(directory).map_err(err)?;
        sysinfo::Disks::new_with_refreshed_list()
            .iter()
            .filter(|disk| path.starts_with(disk.mount_point()))
            .max_by_key(|disk| disk.mount_point().as_os_str().len())
            .map(|disk| disk.available_space())
            .ok_or_else(|| err("Could not determine available model disk space"))
    }

    fn open(&self, entry: &ModelEntry, cancelled: Arc<AtomicBool>) -> Result<Box<dyn Read + Send>> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(err)?;
        let entered = runtime.enter();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(1800))
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .build()
            .map_err(err)?;
        let response = interruptible(&runtime, &cancelled, client.get(&entry.url).send())?
            .error_for_status()
            .map_err(err)?;
        if response
            .content_length()
            .is_some_and(|size| size != entry.expected_bytes)
        {
            return Err(err("Unexpected model size"));
        }
        drop(entered);
        Ok(Box::new(HttpReader {
            runtime,
            response,
            cancelled,
            pending: Cursor::new(Vec::new()),
        }))
    }
}

/// Dropping the pending HTTP future on cancellation closes stalled requests and body reads.
fn interruptible<T>(
    runtime: &tokio::runtime::Runtime,
    cancelled: &AtomicBool,
    future: impl Future<Output = std::result::Result<T, reqwest::Error>>,
) -> Result<T> {
    runtime.block_on(async {
        let mut future = std::pin::pin!(future);
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err(err("Model download cancelled"));
            }
            if let Ok(result) =
                tokio::time::timeout(Duration::from_millis(50), future.as_mut()).await
            {
                return result.map_err(err);
            }
        }
    })
}

struct HttpReader {
    runtime: tokio::runtime::Runtime,
    response: reqwest::Response,
    cancelled: Arc<AtomicBool>,
    pending: Cursor<Vec<u8>>,
}

impl Read for HttpReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            let n = self.pending.read(buffer)?;
            if n > 0 {
                return Ok(n);
            }
            match interruptible(&self.runtime, &self.cancelled, self.response.chunk())
                .map_err(std::io::Error::other)?
            {
                Some(chunk) => self.pending = Cursor::new(chunk.to_vec()),
                None => return Ok(0),
            }
        }
    }
}
