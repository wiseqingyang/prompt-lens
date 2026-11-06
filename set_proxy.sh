#!/bin/bash
# Kept as an explicit migration notice; the old script never saved prior settings.
set -eu
case "${1:-}" in
  status)
    if [ "$(uname -s)" != Darwin ]; then echo 'Only macOS status is supported.' >&2; exit 1; fi
    /usr/sbin/networksetup -getwebproxy "${2:-Wi-Fi}"
    /usr/sbin/networksetup -getsecurewebproxy "${2:-Wi-Fi}"
    ;;
  *)
    echo 'System proxy switching has been retired: the old helper did not save settings and cannot restore them safely.' >&2
    echo 'Use the in-app Agent setup commands for a dedicated process. See docs/UNINSTALL.md for recovery.' >&2
    echo 'Read-only status: ./set_proxy.sh status [network-service]' >&2
    exit 1
    ;;
esac
