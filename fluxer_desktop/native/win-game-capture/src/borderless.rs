// SPDX-License-Identifier: AGPL-3.0-or-later

use napi::bindgen_prelude::*;
use napi_derive::napi;
use windows::Graphics::Capture::{GraphicsCaptureAccess, GraphicsCaptureAccessKind};
use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};

// Request and wait on the same worker apartment; Electron's main thread never blocks.
// The caller gates Windows version, package identity and repeat asks.
#[napi]
pub fn request_borderless_access() -> Result<AsyncTask<BorderlessAccessTask>> {
    Ok(AsyncTask::new(BorderlessAccessTask))
}

fn with_winrt_apartment<T>(complete: impl FnOnce() -> Result<T>) -> Result<T> {
    let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    if let Err(error) = &initialized
        && error.code() != RPC_E_CHANGED_MODE
    {
        return Err(Error::from_reason(error.to_string()));
    }
    let result = complete();
    if initialized.is_ok() {
        unsafe { RoUninitialize() };
    }
    result
}

pub struct BorderlessAccessTask;

impl Task for BorderlessAccessTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<bool> {
        with_winrt_apartment(|| {
            GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
                .and_then(|operation| operation.join())
                .map(|status| status == AppCapabilityAccessStatus::Allowed)
                .map_err(|error| Error::from_reason(error.to_string()))
        })
    }

    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::WinRT::{RO_INIT_SINGLETHREADED, RoGetApartmentIdentifier};

    #[test]
    fn apartment_lives_through_completion_and_is_released_on_error() {
        std::thread::spawn(|| {
            let result: Result<()> = with_winrt_apartment(|| {
                // An implicit process MTA can outlive this thread; probe the explicit
                // initialization with a conflicting mode instead of apartment presence.
                assert_eq!(
                    unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }
                        .unwrap_err()
                        .code(),
                    RPC_E_CHANGED_MODE
                );
                Err(Error::from_reason("completion failed"))
            });
            assert!(result.is_err());
            unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.unwrap();
            unsafe { RoUninitialize() };
        })
        .join()
        .unwrap();
    }

    #[test]
    fn does_not_uninitialize_an_existing_apartment_on_mode_conflict() {
        std::thread::spawn(|| {
            unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.unwrap();
            let before = unsafe { RoGetApartmentIdentifier() }.unwrap();
            let during =
                with_winrt_apartment(|| Ok(unsafe { RoGetApartmentIdentifier() }.unwrap()))
                    .unwrap();
            assert_eq!(before, during);
            assert_eq!(before, unsafe { RoGetApartmentIdentifier() }.unwrap());
            unsafe { RoUninitialize() };
            unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.unwrap();
            unsafe { RoUninitialize() };
        })
        .join()
        .unwrap();
    }
}
