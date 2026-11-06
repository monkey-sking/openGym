# .gate.conf.sh —— openGym 交付门禁配置
# 被 ~/.dsh/skills/delivery-gates/gate.sh source。三条硬规则：
#   1. 每个检查函数以 check_ 开头，内部必须先调 section "N/M 标题" 再记录结果
#   2. 登记进 CHECKS（顺序即执行顺序）
#   3. 每条检查必须配一个能被它抓到的红队用例，登记进 REDTEAM_CASES

ROOT="${ROOT:-${REPO:-$(pwd)}}"
PBXPROJ="$ROOT/frontend/ios/App/App.xcodeproj/project.pbxproj"

build_number() {
  grep -oE 'CURRENT_PROJECT_VERSION = [0-9]+;' "$PBXPROJ" 2>/dev/null \
    | grep -oE '[0-9]+' | head -1
}

# ---------- 1/6 版本一致性 ----------
check_version() {
  section "1/6 版本锚定（iOS/Watch 全部 Target 构建号一致且 >= 68）"
  local versions count uniq min_build=68
  versions=$(grep -oE 'CURRENT_PROJECT_VERSION = [0-9]+;' "$PBXPROJ" 2>/dev/null | grep -oE '[0-9]+' || true)
  count=$(printf '%s\n' "$versions" | sed '/^$/d' | wc -l | tr -d ' ')
  uniq=$(printf '%s\n' "$versions" | sed '/^$/d' | sort -u)
  local uniq_count
  uniq_count=$(printf '%s\n' "$uniq" | sed '/^$/d' | wc -l | tr -d ' ')

  if [ "$count" -lt 6 ] || [ "$uniq_count" -ne 1 ]; then
    echo "project.pbxproj CURRENT_PROJECT_VERSION 不一致: $(printf '%s ' $versions)" | tee -a "$_cur_log"
    record_fail "版本锚定" "project.pbxproj 构建号不一致: $(printf '%s ' $uniq)"
    return
  fi
  if [ "$uniq" -lt "$min_build" ]; then
    echo "CURRENT_PROJECT_VERSION=$uniq 小于要求的 $min_build" | tee -a "$_cur_log"
    record_fail "版本锚定" "构建号 $uniq < $min_build"
    return
  fi
  record_pass "版本锚定 (Build $uniq, $count targets 一致)"
}

# ---------- 2/6 多语言词条完整性 ----------
check_locales() {
  section "2/6 多语言词条校验（19 语言对齐 + 源码 t() 零遗漏）"
  if ( cd "$ROOT/frontend" && node scripts/check-locales.mjs && node scripts/check-source-strings.mjs --strict ) >"$_cur_log" 2>&1; then
    record_pass "多语言词条校验" "$(tr '\n' ' ' <"$_cur_log" | cut -c1-120)"
  else
    cat "$_cur_log"
    record_fail "多语言词条校验" "$(tail -n 3 "$_cur_log" | tr '\n' ' ')"
  fi
}

# ---------- 3/6 Chrome 扩展单测 + 局域网发现 + E2E ----------
check_extension_tests() {
  section "3/6 Chrome 扩展测试（配对码 + 局域网发现 + E2E 跳秒与双向暂停）"
  if ( cd "$ROOT" && node --test tools/video-sync-extension/*.test.mjs ) >"$_cur_log" 2>&1; then
    local summary
    summary=$(grep -E '# (tests|pass|fail)' "$_cur_log" | tr '\n' ' ' || true)
    record_pass "Chrome 扩展测试" "$summary"
  else
    cat "$_cur_log"
    record_fail "Chrome 扩展测试" "$(grep -m1 -E 'Error:|not ok' "$_cur_log" | cut -c1-140)"
  fi
}

# ---------- 4/6 前端核心同步测试（fast 跑同步专项，full 跑全量） ----------
check_frontend_sync_tests() {
  section "4/6 前端测试（视频同步 + 手表心跳 + 设置页预配置）"
  local cmd
  if [ "$MODE" = "fast" ]; then
    cmd=(npx vitest run src/lib/video-sync.test.js src/lib/watch-sync.test.js src/views/VideoSyncSettings.test.jsx)
  else
    cmd=(npm test)
  fi
  if ( cd "$ROOT/frontend" && "${cmd[@]}" ) >"$_cur_log" 2>&1; then
    local summary
    summary=$(grep -E 'Test Files|Tests ' "$_cur_log" | tail -2 | tr '\n' ' ' || true)
    record_pass "前端测试 ($MODE)" "$summary"
  else
    cat "$_cur_log"
    record_fail "前端测试 ($MODE)" "$(grep -m1 -E 'FAIL|Error:' "$_cur_log" | cut -c1-140)"
  fi
}

# ---------- 5/6 WatchCore Swift 单测 ----------
check_watchcore_tests() {
  section "5/6 WatchCore 测试（唯一训练锁 + 双向暂停 + 倒计时与复活拦截）"
  if [ "$SKIP_BUILD" = "1" ]; then
    record_warn "WatchCore 测试" "--skip-build 已跳过"
    return
  fi
  if ( cd "$ROOT/frontend/ios/App/WatchCore" && swift test --disable-sandbox ) >"$_cur_log" 2>&1; then
    local summary
    summary=$(grep -E 'Executed [0-9]+ tests' "$_cur_log" | tail -1 || true)
    record_pass "WatchCore 测试" "$summary"
  else
    cat "$_cur_log"
    record_fail "WatchCore 测试" "$(grep -m1 -E 'error:|failed' "$_cur_log" | cut -c1-140)"
  fi
}

# ---------- 6/6 复盘回填 ----------
check_retro_backfill() {
  section "6/6 复盘回填（改过源码必须有更新的 docs/Process/retro-*.md）"
  local base changed newest_src retro_newest
  base=$(dg_latest_commit)
  if ! git -C "$ROOT" rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
    base="HEAD~1"
  fi
  changed=$(dg_changed "$base" frontend/src frontend/ios/App tools/video-sync-extension | grep -E '\.(js|jsx|mjs|swift)$' || true)
  if [ -z "$changed" ]; then
    record_pass "复盘回填（本批无源码改动）"
    return
  fi

  # shellcheck disable=SC2086
  newest_src=$(cd "$ROOT" && ls -t $changed 2>/dev/null | head -1)
  retro_newest=$(find "$ROOT/docs/Process" -maxdepth 1 -name 'retro-*.md' -newer "$ROOT/$newest_src" -print 2>/dev/null | head -1)
  if [ -z "$retro_newest" ]; then
    local tail_line
    tail_line=$(tail -n 1 "$ROOT/$newest_src" 2>/dev/null || true)
    echo "源码 $newest_src ($tail_line) 比 docs/Process/retro-*.md 更新，缺少本次复盘回填" | tee -a "$_cur_log"
    record_fail "复盘回填" "源码 $newest_src 比 retro-*.md 更新"
    return
  fi

  local missing=""
  grep -q "用户看到的现象" "$retro_newest" || missing="$missing 用户看到的现象"
  grep -q "真实根因" "$retro_newest" || missing="$missing 真实根因"
  grep -q "被哪一层挡住" "$retro_newest" || missing="$missing 被哪一层挡住"
  grep -q "新增机制" "$retro_newest" || missing="$missing 新增机制"
  if [ -n "$missing" ]; then
    echo "复盘回填缺少字段:$missing" | tee -a "$_cur_log"
    record_fail "复盘回填" "缺少字段:$missing"
    return
  fi
  record_pass "复盘回填 (${retro_newest#$ROOT/})"
}

CHECKS=(
  check_version
  check_locales
  check_extension_tests
  check_frontend_sync_tests
  check_watchcore_tests
  check_retro_backfill
)

# ---------- 红队用例（每个对应上面一条检查，输出唯一标记且可恢复） ----------
case_version_drift() {
  cp "$PBXPROJ" "$TMPDIR_RT/project.pbxproj.bak"
  python3 - "$PBXPROJ" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
open(p, "w").write(s.replace("CURRENT_PROJECT_VERSION = 69;", "CURRENT_PROJECT_VERSION = 99999;", 1))
PY
  echo "99999"
}

case_locale_missing_key() {
  local target="$ROOT/frontend/src/views/VideoSyncSettings.jsx"
  cp "$target" "$TMPDIR_RT/VideoSyncSettings.jsx.bak"
  printf "\n// redteam\nconst _rt = () => t('REDTEAM_MISSING_I18N_KEY_20261105');\n" >>"$target"
  echo "REDTEAM_MISSING_I18N_KEY_20261105"
}

case_extension_break() {
  local target="$ROOT/tools/video-sync-extension/discovery.test.mjs"
  cp "$target" "$TMPDIR_RT/discovery.test.mjs.bak"
  printf "\ntest('REDTEAM_EXTENSION_BROKEN_20261105', () => { throw new Error('REDTEAM_EXTENSION_BROKEN_20261105'); });\n" >>"$target"
  echo "REDTEAM_EXTENSION_BROKEN_20261105"
}

case_frontend_sync_break() {
  local target="$ROOT/frontend/src/lib/video-sync.test.js"
  cp "$target" "$TMPDIR_RT/video-sync.test.js.bak"
  printf "\nit('REDTEAM_FRONTEND_SYNC_BROKEN_20261105', () => { throw new Error('REDTEAM_FRONTEND_SYNC_BROKEN_20261105'); });\n" >>"$target"
  echo "REDTEAM_FRONTEND_SYNC_BROKEN_20261105"
}

case_watchcore_break() {
  local target="$ROOT/frontend/ios/App/WatchCore/Tests/WatchCoreTests/SessionCoreTests.swift"
  cp "$target" "$TMPDIR_RT/SessionCoreTests.swift.bak"
  printf "\nfunc testRedteamBroken() { RedteamWatchCoreMarkerBroken20261105() }\n" >>"$target"
  echo "RedteamWatchCoreMarkerBroken20261105"
}

case_retro_missing() {
  local target="$ROOT/frontend/ios/App/WatchCore/Sources/WatchCore/SessionCore.swift"
  cp "$target" "$TMPDIR_RT/SessionCore.swift.bak"
  printf "\n// REDTEAM_RETRO_MISSING_20261105\n" >>"$target"
  echo "REDTEAM_RETRO_MISSING_20261105"
}

case_cleanup() {
  [ -f "$TMPDIR_RT/project.pbxproj.bak" ] && cp "$TMPDIR_RT/project.pbxproj.bak" "$PBXPROJ" && rm -f "$TMPDIR_RT/project.pbxproj.bak"
  [ -f "$TMPDIR_RT/VideoSyncSettings.jsx.bak" ] && cp "$TMPDIR_RT/VideoSyncSettings.jsx.bak" "$ROOT/frontend/src/views/VideoSyncSettings.jsx" && rm -f "$TMPDIR_RT/VideoSyncSettings.jsx.bak"
  [ -f "$TMPDIR_RT/discovery.test.mjs.bak" ] && cp "$TMPDIR_RT/discovery.test.mjs.bak" "$ROOT/tools/video-sync-extension/discovery.test.mjs" && rm -f "$TMPDIR_RT/discovery.test.mjs.bak"
  [ -f "$TMPDIR_RT/video-sync.test.js.bak" ] && cp "$TMPDIR_RT/video-sync.test.js.bak" "$ROOT/frontend/src/lib/video-sync.test.js" && rm -f "$TMPDIR_RT/video-sync.test.js.bak"
  [ -f "$TMPDIR_RT/SessionCoreTests.swift.bak" ] && cp "$TMPDIR_RT/SessionCoreTests.swift.bak" "$ROOT/frontend/ios/App/WatchCore/Tests/WatchCoreTests/SessionCoreTests.swift" && rm -f "$TMPDIR_RT/SessionCoreTests.swift.bak"
  [ -f "$TMPDIR_RT/SessionCore.swift.bak" ] && cp "$TMPDIR_RT/SessionCore.swift.bak" "$ROOT/frontend/ios/App/WatchCore/Sources/WatchCore/SessionCore.swift" && rm -f "$TMPDIR_RT/SessionCore.swift.bak"
  # 恢复后保证 retro 时间戳不早于源码
  for r in "$ROOT"/docs/Process/retro-*.md; do
    [ -f "$r" ] && touch "$r"
  done
  return 0
}

REDTEAM_CASES=(
  case_version_drift
  case_locale_missing_key
  case_extension_break
  case_frontend_sync_break
  case_watchcore_break
  case_retro_missing
)
