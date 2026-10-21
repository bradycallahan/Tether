; Tauri NSIS hooks. The uninstaller removes what Settings > Files >
; "Offer Tether for ssh:// and telnet:// links" registered (see src/links.rs),
; so Windows stops listing Tether in Default apps. Other apps' keys stay.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\RegisteredApplications" "Tether"
  DeleteRegKey HKCU "Software\Classes\Tether.ssh"
  DeleteRegKey HKCU "Software\Classes\Tether.telnet"
  DeleteRegKey HKCU "Software\Tether\Capabilities"
  DeleteRegKey /ifempty HKCU "Software\Tether"
!macroend
