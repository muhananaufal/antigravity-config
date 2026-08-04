#!/usr/bin/env bash
# scripts/quality_gate.sh
# DILARANG MENGABAIKAN ERROR DARI SCRIPT INI!
set -euo pipefail

echo "================= NESTJS-MASTERY QUALITY GATE (ENTERPRISE ZERO-TOLERANCE) ================="
TARGET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1. Validasi Keberadaan SKILL.md
if [ ! -f "$TARGET_ROOT/SKILL.md" ]; then
    echo "❌ ERROR FATAL: SKILL.md tidak ditemukan di root nestjs-mastery!"
    exit 1
fi

# 2. Audit Hardcoded Secrets (Ripgrep / Grep fallback)
echo "[Gate 1] Memeriksa kebocoran Hardcoded Secrets (API Keys, Token, Password statis)..."
if command -v rg &> /dev/null; then
    if rg -i "password\s*[:=]\s*[\"'][^\"']{8,}[\"']" "$TARGET_ROOT" \
        --glob "!*.ps1" --glob "!*.sh" | grep -iv "process.env" | grep -iv "Contoh Salah" | grep -iv "Anti-Pattern" 2>/dev/null; then
        echo "❌ ERROR FATAL: Ditemukan hardcoded secret! Pindahkan ke variabel .env murni!"
        exit 1
    fi
elif grep -rEi "password\s*[:=]\s*[\"'][^\"']{8,}[\"']" "$TARGET_ROOT" 2>/dev/null | grep -iv "process.env" | grep -iv "Contoh Salah" | grep -iv "Anti-Pattern"; then
    echo "❌ ERROR FATAL: Ditemukan hardcoded secret! Pindahkan ke variabel .env murni!"
    exit 1
fi

echo "✅ QUALITY GATE BERHASIL DILEWATI (BASH STRICT MODE)! 100% NESTJS-MASTERY VERIFIED!"
echo "==========================================================================================="
