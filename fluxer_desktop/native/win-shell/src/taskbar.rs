// SPDX-License-Identifier: AGPL-3.0-or-later

use napi::Task;
use napi::bindgen_prelude::{AsyncTask, Buffer, Env, Error, Result, Status};
use napi_derive::napi;
use windows::UI::Shell::{ITaskbarManagerDesktopAppSupportStatics, TaskbarManager};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, HWND};
use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RegGetValueW};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Shell::IInitializeWithWindow;
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
use windows::core::{Interface, PCWSTR, factory};
use windows_future::IAsyncOperation;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct TaskbarPinState {
    pub supported: bool,
    pub pinned: bool,
    #[napi(js_name = "lafRequired")]
    pub laf_required: bool,
}

pub struct TaskbarStateTask {
    state: TaskbarPinState,
    operation: Option<IAsyncOperation<bool>>,
}

pub struct TaskbarRequestTask {
    operation: Option<IAsyncOperation<bool>>,
}

fn winrt_error(error: windows::core::Error) -> Error {
    Error::new(Status::GenericFailure, format!("TaskbarManager: {error}"))
}

fn can_pin(desktop: bool, supported: bool, allowed: bool, laf: bool) -> bool {
    desktop && supported && allowed && !laf
}

fn parse_hwnd(bytes: &[u8]) -> Result<HWND> {
    let raw = usize::from_ne_bytes(
        bytes
            .try_into()
            .map_err(|_| Error::new(Status::InvalidArg, "Expected a native-sized HWND buffer"))?,
    );
    if raw == 0 {
        return Err(Error::new(Status::InvalidArg, "HWND must be nonzero"));
    }
    Ok(HWND(raw as *mut std::ffi::c_void))
}

// Exact DWORD seed documented by Microsoft: /windows/apps/develop/windows-integration/pin-to-taskbar.
fn laf_required() -> Result<bool> {
    let key: Vec<u16> = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModel\\LimitedAccessFeatures\\com.microsoft.windows.taskbar.pin\0".encode_utf16().collect();
    let seed: Vec<u16> = "4096B239A7295B635C090E647E867B5707DA6AB6CB78340B01FE4E0C8F4953D4\0"
        .encode_utf16()
        .collect();
    let mut value = 0u32;
    let mut size = std::mem::size_of_val(&value) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            PCWSTR(seed.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut value as *mut u32).cast()),
            Some(&mut size),
        )
    };
    if status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
        return Ok(false);
    }
    if status != ERROR_SUCCESS {
        return Err(Error::new(
            Status::GenericFailure,
            format!("Taskbar LAF registry read failed: {}", status.0),
        ));
    }
    Ok(value != 0)
}

fn available_manager(laf: bool) -> Result<Option<TaskbarManager>> {
    // Never invoke restricted methods without a LAF token on older Windows versions.
    if laf {
        return Ok(None);
    }
    if let Err(error) = factory::<TaskbarManager, ITaskbarManagerDesktopAppSupportStatics>() {
        return match error.code().0 as u32 {
            0x80004002 | 0x80040154 => Ok(None), // E_NOINTERFACE / REGDB_E_CLASSNOTREG
            _ => Err(winrt_error(error)),
        };
    }
    let manager = TaskbarManager::GetDefault().map_err(winrt_error)?;
    if can_pin(
        true,
        manager.IsSupported().map_err(winrt_error)?,
        manager.IsPinningAllowed().map_err(winrt_error)?,
        laf,
    ) {
        Ok(Some(manager))
    } else {
        Ok(None)
    }
}

// These entry points execute on Electron's calling UI thread. Only completion is sent to libuv.
#[napi(js_name = "getTaskbarPinState")]
pub fn get_taskbar_pin_state() -> Result<AsyncTask<TaskbarStateTask>> {
    let laf = laf_required()?;
    let manager = available_manager(laf)?;
    let operation = manager
        .as_ref()
        .map(|manager| manager.IsCurrentAppPinnedAsync())
        .transpose()
        .map_err(winrt_error)?;
    Ok(AsyncTask::new(TaskbarStateTask {
        state: TaskbarPinState {
            supported: manager.is_some(),
            pinned: false,
            laf_required: laf,
        },
        operation,
    }))
}

#[napi(js_name = "requestTaskbarPin")]
pub fn request_taskbar_pin(hwnd: Buffer) -> Result<AsyncTask<TaskbarRequestTask>> {
    let hwnd = parse_hwnd(&hwnd)?;
    if unsafe { GetForegroundWindow() } != hwnd
        || unsafe { GetWindowThreadProcessId(hwnd, None) } != unsafe { GetCurrentThreadId() }
    {
        return Err(Error::new(
            Status::InvalidArg,
            "Taskbar pinning requires the foreground window's UI thread",
        ));
    }
    let operation = if let Some(manager) = available_manager(laf_required()?)? {
        // Microsoft's desktop sample calls GetDefault directly. Initialize an owner when the OS
        // exposes this optional interop interface; E_NOINTERFACE uses the documented sample path.
        match manager.cast::<IInitializeWithWindow>() {
            Ok(interop) => unsafe { interop.Initialize(hwnd) }.map_err(winrt_error)?,
            Err(error) if error.code().0 as u32 == 0x80004002 => {}
            Err(error) => return Err(winrt_error(error)),
        }
        Some(manager.RequestPinCurrentAppAsync().map_err(winrt_error)?)
    } else {
        None
    };
    Ok(AsyncTask::new(TaskbarRequestTask { operation }))
}

impl Task for TaskbarStateTask {
    type Output = TaskbarPinState;
    type JsValue = TaskbarPinState;

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(operation) = &self.operation {
            self.state.pinned = operation.join().map_err(winrt_error)?;
        }
        Ok(self.state.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

impl Task for TaskbarRequestTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<Self::Output> {
        self.operation
            .as_ref()
            .map(|operation| operation.join())
            .transpose()
            .map(|result| result.unwrap_or(false))
            .map_err(winrt_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn pin_requires_all_capabilities_and_no_laf() {
        for desktop in [false, true] {
            for supported in [false, true] {
                for allowed in [false, true] {
                    for laf in [false, true] {
                        assert_eq!(
                            super::can_pin(desktop, supported, allowed, laf),
                            desktop && supported && allowed && !laf
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn window_handle_must_be_native_sized_and_nonzero() {
        assert!(super::parse_hwnd(&[]).is_err());
        assert!(super::parse_hwnd(&[0; std::mem::size_of::<usize>()]).is_err());
        assert_eq!(
            super::parse_hwnd(&1usize.to_ne_bytes()).unwrap().0 as usize,
            1
        );
    }
}
