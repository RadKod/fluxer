// SPDX-License-Identifier: AGPL-3.0-or-later

use napi::Task;
use napi::bindgen_prelude::{AsyncTask, Env, Error, Result, Status};
use napi_derive::napi;
use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_FILES, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};

const MAX_PROCESSES: usize = 20_000;
const MAX_FILENAME_UNITS: usize = 260;

#[napi(object)]
#[derive(Debug)]
pub struct ProcessInfo {
    pub exe: String,
    pub pid: u32,
}

pub struct ListProcessesTask;

#[napi(js_name = "listProcesses")]
pub fn list_processes() -> AsyncTask<ListProcessesTask> {
    AsyncTask::new(ListProcessesTask)
}

impl Task for ListProcessesTask {
    type Output = Vec<ProcessInfo>;
    type JsValue = Vec<ProcessInfo>;

    fn compute(&mut self) -> Result<Self::Output> {
        let snapshot = Snapshot(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(snapshot_error)?,
        );
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut entries = Vec::new();
        let mut found = has_entry(unsafe { Process32FirstW(snapshot.0, &mut entry) })?;
        while found {
            append_process(&mut entries, &entry.szExeFile, entry.th32ProcessID)?;
            found = has_entry(unsafe { Process32NextW(snapshot.0, &mut entry) })?;
        }
        Ok(entries)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

struct Snapshot(HANDLE);

impl Drop for Snapshot {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn snapshot_error(error: windows::core::Error) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Process snapshot failed: {error}"),
    )
}

fn has_entry(result: windows::core::Result<()>) -> Result<bool> {
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.code() == ERROR_NO_MORE_FILES.to_hresult() => Ok(false),
        Err(error) => Err(snapshot_error(error)),
    }
}

fn process_name(raw: &[u16]) -> Result<String> {
    let length = raw.iter().position(|unit| *unit == 0).unwrap_or(raw.len());
    if length == 0 || length > MAX_FILENAME_UNITS {
        return Err(Error::new(
            Status::GenericFailure,
            "Invalid process filename length",
        ));
    }
    let name = String::from_utf16(&raw[..length])
        .map_err(|_| Error::new(Status::GenericFailure, "Invalid process filename UTF-16"))?;
    if name
        .chars()
        .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
    {
        return Err(Error::new(
            Status::GenericFailure,
            "Invalid process filename characters",
        ));
    }
    Ok(name)
}

fn append_process(entries: &mut Vec<ProcessInfo>, raw: &[u16], pid: u32) -> Result<()> {
    if entries.len() >= MAX_PROCESSES {
        return Err(Error::new(
            Status::GenericFailure,
            "Process snapshot exceeds entry limit",
        ));
    }
    entries.push(ProcessInfo {
        exe: process_name(raw)?,
        pid,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(name: &str) -> Vec<u16> {
        name.encode_utf16().chain([0]).collect()
    }

    #[test]
    fn converts_unicode_filename_and_ignores_buffer_after_terminator() {
        let mut raw = wide("Oyun😀.exe");
        raw.extend([0xd800, b'/' as u16]);
        assert_eq!(process_name(&raw).unwrap(), "Oyun😀.exe");
    }

    #[test]
    fn rejects_empty_and_invalid_utf16_filenames() {
        for raw in [vec![], vec![0], vec![0xd800, 0], vec![0xdc00, 0]] {
            assert!(process_name(&raw).is_err(), "{raw:?}");
        }
    }

    #[test]
    fn rejects_paths_and_control_characters() {
        for name in [
            "a/b.exe",
            "a\\b.exe",
            "a\n.exe",
            "a\u{7f}.exe",
            "a\u{85}.exe",
        ] {
            assert!(process_name(&wide(name)).is_err(), "{name:?}");
        }
    }

    #[test]
    fn bounds_filename_by_utf16_units() {
        assert!(process_name(&wide(&"a".repeat(260))).is_ok());
        assert!(process_name(&wide(&"a".repeat(261))).is_err());
        assert!(process_name(&wide(&"😀".repeat(130))).is_ok());
        assert!(process_name(&wide(&"😀".repeat(131))).is_err());
    }

    #[test]
    fn preserves_executable_case_and_pid() {
        let mut entries = Vec::new();
        append_process(&mut entries, &wide("Game.EXE"), u32::MAX).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].exe, "Game.EXE");
        assert_eq!(entries[0].pid, u32::MAX);
    }

    #[test]
    fn rejects_record_overflow_without_appending() {
        let mut entries = Vec::new();
        let raw = wide("game.exe");
        for pid in 0..20_000 {
            append_process(&mut entries, &raw, pid).unwrap();
        }
        assert_eq!(entries.len(), 20_000);
        assert!(append_process(&mut entries, &raw, 20_000).is_err());
        assert_eq!(entries.len(), 20_000);
    }

    #[test]
    fn invalid_filename_does_not_append_a_record() {
        let mut entries = Vec::new();
        assert!(append_process(&mut entries, &wide("bad/path.exe"), 1).is_err());
        assert!(entries.is_empty());
    }

    #[test]
    fn enumeration_only_treats_no_more_files_as_completion() {
        use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_NO_MORE_FILES};
        assert!(has_entry(Ok(())).unwrap());
        assert!(
            !has_entry(Err(windows::core::Error::from_hresult(
                ERROR_NO_MORE_FILES.to_hresult()
            )))
            .unwrap()
        );
        assert!(
            has_entry(Err(windows::core::Error::from_hresult(
                ERROR_ACCESS_DENIED.to_hresult()
            )))
            .is_err()
        );
    }
}
