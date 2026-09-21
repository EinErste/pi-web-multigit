/**
 * Pane layout: the stylesheet, the width arithmetic, and the draggable dividers.
 */

export const CSS = `
.mg-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);color:var(--text);font-size:12.5px}
.mg-head{display:flex;flex-direction:column;gap:6px;padding:7px 10px;border-bottom:1px solid var(--border);flex:0 0 auto}
.mg-head-top{display:flex;align-items:center;gap:10px;min-width:0}
.mg-head-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.mg-hgroup{display:flex;align-items:center;gap:6px;padding:2px 6px;border:1px solid var(--border-soft);border-radius:8px;background:var(--bg-elev2,transparent);min-width:0}
.mg-hgroup > .mg-search{min-width:120px}
.mg-title{font-weight:600}
.mg-sub{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;color:var(--text-dim);font-size:11.5px}
.mg-status-scan{flex:0 0 auto;width:74px;color:var(--accent);font-size:11px;opacity:0}
.mg-sub.scanning .mg-status-scan{opacity:1}
.mg-sub.scanning .mg-status-part{opacity:.55}
.mg-status-part{flex:0 0 auto;font-variant-numeric:tabular-nums;transition:opacity .15s}
.mg-status-repos{min-width:7ch}
.mg-status-dirty{min-width:15ch}
.mg-status-dirty.dirty{color:var(--yellow-text,var(--yellow,inherit))}
.mg-status-cwd{flex:0 1 auto;min-width:0;max-width:52ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:11px;color:var(--text-faint);background:none;border:none;padding:0;cursor:pointer;text-align:left}
.mg-status-cwd:hover{color:var(--text-dim);text-decoration:underline dotted}
.mg-search{flex:0 1 250px;min-width:120px;font:inherit;font-size:12px;color:var(--control-fg,inherit);background:var(--control-bg);border:1px solid var(--control-border,var(--border));border-radius:6px;padding:3px 8px}
.mg-search:focus{outline:none;border-color:var(--accent)}
.mg-search-regex.active,.mg-search-regex.active:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
.mg-spacer{flex:1 1 auto}
.mg-btn{font:inherit;color:var(--control-fg,inherit);background:var(--control-bg);border:1px solid var(--control-border,var(--border));border-radius:6px;padding:3px 10px;cursor:pointer}
.mg-btn:hover{background:var(--bg-elev)}
.mg-btn.sm{padding:1px 7px;font-size:11px}
.mg-select{font:inherit;color:var(--control-fg,inherit);background:var(--control-bg);border:1px solid var(--control-border,var(--border));border-radius:6px;padding:3px 6px}
.mg-check{display:flex;align-items:center;gap:5px;color:var(--text-dim);cursor:pointer;user-select:none}
.mg-body{flex:1 1 auto;display:flex;align-items:stretch;min-width:0;min-height:0}
.mg-pane{display:flex;flex-direction:column;flex:1 1 0;min-width:0;min-height:0;border-right:1px solid var(--border)}
.mg-pane-fixed{flex:0 0 auto}
.mg-split{flex:0 0 10px;cursor:col-resize;position:relative;user-select:none;touch-action:none}
.mg-split::after{content:"";position:absolute;left:4px;top:0;bottom:0;width:2px;background:var(--border-soft);border-radius:1px;transition:background .1s}
/* Grip: three dimples in the middle of the divider, so it reads as something you can grab. */
.mg-split::before{content:"";position:absolute;left:3px;top:50%;margin-top:-9px;width:4px;height:18px;border-radius:2px;background:radial-gradient(circle,var(--text-faint) 1px,transparent 1px) center/4px 6px repeat-y;opacity:.7}
.mg-split:hover::after,.mg-split.dragging::after{background:var(--accent);left:3px;width:4px}
.mg-split:hover::before,.mg-split.dragging::before{opacity:1}
.mg-pane-head{display:flex;align-items:center;gap:6px;justify-content:space-between;padding:5px 8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-dim);border-bottom:1px solid var(--border-soft);flex:0 0 auto;min-height:28px}
.mg-list{flex:1 1 auto;overflow:auto;min-height:0}
.mg-list::-webkit-scrollbar,.mg-diff-body::-webkit-scrollbar{width:10px;height:10px}
.mg-list::-webkit-scrollbar-thumb,.mg-diff-body::-webkit-scrollbar-thumb{background:var(--scroll-thumb);border-radius:6px}
.mg-repo{display:block;width:100%;text-align:left;color:inherit;font:inherit;background:none;border:none;border-bottom:1px solid var(--border-soft);padding:6px 8px;cursor:pointer}
.mg-repo:hover{background:var(--bg-elev)}
.mg-repo.active{background:var(--accent-soft,var(--bg-elev));box-shadow:inset 2px 0 0 var(--accent)}
.mg-repo-line1{display:flex;align-items:center;gap:6px;min-width:0}
.mg-repo-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-ab{margin-left:auto;display:flex;gap:5px;font-size:11px;flex:0 0 auto}
.mg-ahead{color:var(--green)}
.mg-behind{color:var(--amber)}
.mg-badge{font-size:10px;padding:0 4px;border:1px solid var(--border);border-radius:4px;color:var(--text-dim);flex:0 0 auto}
.mg-repo-line2{display:flex;gap:6px;font-size:11px;margin-top:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mg-branch{color:var(--link);flex:0 0 auto}
.mg-dirty{color:var(--amber);overflow:hidden;text-overflow:ellipsis}
.mg-clean{color:var(--text-faint)}
.mg-err{color:var(--red-text,var(--red))}
.mg-repo-head{font-size:11px;color:var(--text-faint);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-repo-state{display:flex;gap:4px;margin-top:2px;flex-wrap:wrap}
.mg-state{font-size:10px;padding:0 5px;border-radius:4px;border:1px solid var(--border);color:var(--text-dim)}
.mg-state.danger{color:var(--red-text,var(--red));border-color:var(--red-soft,var(--border))}
.mg-state.warn{color:var(--amber-text,var(--amber));border-color:var(--amber,var(--border))}
.mg-tabs{display:flex;gap:4px;flex:0 0 auto;flex-wrap:wrap}
.mg-tab{font:inherit;font-size:11px;color:var(--text-dim);background:none;border:1px solid transparent;border-radius:5px;padding:2px 8px;cursor:pointer}
.mg-tab:hover{color:var(--text)}
.mg-tab.active{color:var(--text);background:var(--chip-bg,var(--bg-elev));border-color:var(--border)}
.mg-repo-meta{padding:6px 8px;font-size:11px;color:var(--text-dim);border-bottom:1px solid var(--border-soft);display:flex;flex-direction:column;gap:2px;flex:0 0 auto}
.mg-meta-row{display:flex;gap:6px;min-width:0}
.mg-meta-k{color:var(--text-faint);min-width:70px;flex:0 0 auto}
.mg-meta-v{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-file{display:flex;align-items:center;gap:6px;width:100%;text-align:left;color:inherit;font:inherit;background:none;border:none;border-bottom:1px solid var(--border-soft);padding:4px 8px;cursor:pointer}
.mg-file:hover{background:var(--bg-elev)}
.mg-file.active{background:var(--accent-soft,var(--bg-elev));box-shadow:inset 2px 0 0 var(--accent)}
/* ---- changed-file row with its rollback action (action outside the row button: no nested buttons) ---- */
.mg-file-wrap{display:flex;align-items:stretch;border-bottom:1px solid var(--border-soft)}
.mg-file-wrap .mg-file{border-bottom:none;flex:1 1 auto;min-width:0}
.mg-file-act{flex:0 0 auto;align-self:center;margin-right:6px;border:1px solid var(--border);background:none;color:var(--text-faint);border-radius:4px;font:inherit;font-size:10.5px;padding:1px 6px;cursor:pointer;white-space:nowrap}
.mg-file-act:hover{color:var(--text);border-color:var(--accent)}
.mg-file-act.armed{color:#fff;background:var(--red);border-color:var(--red)}
.mg-btn.armed{color:#fff;background:var(--red);border-color:var(--red)}
.mg-xy{width:13px;text-align:center;font-family:var(--mono);font-size:11px;flex:0 0 auto}
.mg-xy-x{color:var(--amber)}
.mg-xy-y{color:var(--red-text,var(--red))}
.mg-xy-q{color:var(--text-faint)}
.mg-file-path{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:11.5px}
.mg-stat{font-family:var(--mono);font-size:11px;flex:0 0 auto;display:flex;gap:5px}
.mg-stat .add{color:var(--green)}
.mg-stat .del{color:var(--red)}
.mg-commit{display:flex;gap:6px;width:100%;text-align:left;color:inherit;font:inherit;background:none;border:none;border-bottom:1px solid var(--border-soft);padding:5px 8px;cursor:pointer}
.mg-commit:hover{background:var(--bg-elev)}
.mg-commit.active{background:var(--accent-soft,var(--bg-elev));box-shadow:inset 2px 0 0 var(--accent)}
.mg-brow.active{background:var(--accent-soft,var(--bg-elev));box-shadow:inset 2px 0 0 var(--accent)}
.mg-graph{font-family:var(--mono);color:var(--text-faint);white-space:pre;flex:0 0 auto}
.mg-commit-main{min-width:0;flex:1 1 auto;display:flex;flex-direction:column}
.mg-commit-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-commit-meta{font-size:11px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-commit-refs{font-size:11px;color:var(--link);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-brow{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;color:inherit;font:inherit;background:none;border:none;border-bottom:1px solid var(--border-soft);padding:5px 8px;cursor:pointer}
.mg-brow:hover{background:var(--bg-elev)}
.mg-brow-line1{display:flex;align-items:center;gap:6px;min-width:0}
.mg-brow-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-brow-name.current{color:var(--link)}
.mg-brow-meta{font-size:11px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-brow-tags{display:flex;gap:4px;flex-wrap:wrap}
/* ---- branch grouping bar (Workspace tab) ---- */
.mg-groupbar{display:flex;align-items:center;gap:6px;padding:5px 9px;border-bottom:1px solid var(--border-soft);background:var(--bg-elev);flex-wrap:wrap}
.mg-groupbar-label{font-size:11px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.04em}
.mg-groupbar-input{flex:0 1 340px;min-width:150px;font-family:var(--mono);font-size:11.5px}
.mg-groupbar-state{font-size:11px;color:var(--text-dim);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
/* ---- health strip, repo-list filters, cross-repo rows ---- */
.mg-chips{display:flex;gap:4px;align-items:center;flex-wrap:wrap;padding:5px 8px;border-bottom:1px solid var(--border);font-size:11px;color:var(--text-dim);flex:0 0 auto;background:var(--bg-elev2,transparent)}
.mg-chips:empty{display:none}
.mg-chips .mg-chipbtn{font-size:10.5px;padding:0 7px;gap:3px}
.mg-chips .mg-chipbtn.zero{opacity:.55} /* the eye lands on what is actually wrong */
.mg-chipbtn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border);background:none;color:var(--text-dim);border-radius:999px;font:inherit;font-size:11px;padding:1px 9px;cursor:pointer}
.mg-chipbtn:hover{color:var(--text);border-color:var(--accent)}
.mg-chipbtn.active{background:var(--accent);border-color:var(--accent);color:#fff}
.mg-chipbtn.zero{opacity:.45}
.mg-chipbtn .n{font-family:var(--mono);font-weight:600}
.mg-chipbtn-plain{border-style:dashed}
.mg-group-head{position:sticky;top:0;z-index:1;padding:3px 8px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint);background:var(--bg-elev);border-bottom:1px solid var(--border-soft)}
.mg-filter{flex:0 1 150px;min-width:110px}
.mg-select-sm{padding:2px 4px;font-size:11px}
.mg-ws-summary{display:flex;flex-wrap:wrap;gap:5px;padding:7px 9px;border-bottom:1px solid var(--border);background:var(--bg-elev)}
.mg-sub-head{display:flex;align-items:center;gap:7px;padding:5px 9px;font-size:11.5px;font-weight:600;color:var(--text);background:var(--bg-elev2,var(--bg-elev));border-bottom:1px solid var(--border-soft);flex-wrap:wrap}
.mg-mono{font-family:var(--mono)}
.mg-brow-h{flex-direction:row;align-items:center;gap:8px}
.mg-brow-h .mg-brow-name{flex:0 0 17ch;max-width:17ch;font-size:11.5px}
.mg-brow-h .mg-brow-track{flex:1 1 auto}
.mg-brow-track{font-family:var(--mono);font-size:11px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
.mg-brow-h .mg-brow-flags{margin-left:auto;font-size:10.5px;color:var(--text-faint);flex:0 0 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34%}
.mg-brow-h .mg-state{flex:0 0 auto}
.mg-gut-blame{width:auto;min-width:74px;padding:0 5px 0 6px;background:none;border-right:1px solid var(--border-soft)}
.mg-blame-hash{border:none;background:none;color:var(--link);font:inherit;font-family:var(--mono);font-size:10.5px;padding:0;cursor:pointer;text-decoration:underline dotted}
.mg-blame-hash:hover{color:var(--link-hover,var(--link))}
.mg-blame-who{flex:0 0 auto;width:17ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-faint);font-size:10.5px;padding-right:6px}
.mg-hunk-focus{background:var(--accent-soft,rgba(139,92,246,.14)) !important}
.mg-tl-filter{display:flex;gap:6px;align-items:center;padding:5px 8px;border-bottom:1px solid var(--border);background:var(--bg-elev);flex-wrap:wrap}
.mg-group{position:sticky;top:0;z-index:1;background:var(--panel-bg,var(--bg));padding:3px 8px;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--text-dim);border-bottom:1px solid var(--border-soft)}
.mg-hit{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;color:inherit;font:inherit;background:none;border:none;border-bottom:1px solid var(--border-soft);padding:4px 8px;cursor:pointer}
.mg-hit:hover{background:var(--bg-elev)}
.mg-hit-line{font-family:var(--mono);color:var(--text-faint);flex:0 0 auto}
.mg-hit-path{font-family:var(--mono);color:var(--link);flex:0 0 auto;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-hit-text{font-family:var(--mono);color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.mg-section-back{display:flex;align-items:center;justify-content:space-between;gap:8px}
.mg-section{padding:4px 8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-dim);background:var(--bg-elev);border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft)}
.mg-section-sub{padding:4px 8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-dim);background:var(--bg-elev);border-bottom:1px solid var(--border-soft)}
.mg-diff-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);text-transform:none;letter-spacing:0}
.mg-diff-actions{display:flex;gap:5px;flex:0 0 auto}
.mg-diff-body{flex:1 1 auto;overflow:auto;min-height:0;background:var(--code-bg);font-family:var(--mono);font-size:12px;line-height:1.45}
.mg-line{white-space:pre;padding:0 8px}
.mg-line-ctx{color:var(--code-text,var(--text))}
.mg-line-head{color:var(--text-dim)}
.mg-line-meta{color:var(--text-faint)}
.mg-line-hunk{color:var(--info-blue,var(--link));background:var(--bg-elev)}
.mg-line-add{color:var(--green)}
.mg-line-del{color:var(--red)}
.mg-line-file{color:var(--code-text,var(--text))}
.mg-line.mg-hit{background:rgba(255,190,0,.15);color:var(--text)}
.mg-empty{padding:10px;color:var(--text-faint)}
.mg-foot{flex:0 0 auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:5px 10px;border-top:1px solid var(--border);color:var(--text-dim);font-size:11px}
.mg-foot-dim{color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46ch}
.mg-pane-head-right{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.mg-term-btn{font:inherit;font-size:11px;color:var(--text-dim);background:none;border:1px solid var(--border);border-radius:5px;padding:2px 8px;cursor:pointer}
.mg-term-btn:hover{color:var(--text)}
.mg-term-btn.active{color:var(--text);background:var(--chip-bg,var(--bg-elev))}
.mg-term{display:flex;flex-direction:column;flex:0 0 auto;height:190px;min-height:120px;border-top:1px solid var(--border);overflow:hidden}
.mg-term-head{display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:11px;color:var(--text-dim);border-bottom:1px solid var(--border-soft);flex:0 0 auto}
.mg-term-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);flex:1 1 auto}
.mg-term-clear{border:none;background:none;color:var(--text-faint);cursor:pointer;font:inherit;padding:0 4px}
.mg-term-clear:hover{color:var(--text)}
.mg-term-host{flex:1 1 auto;min-height:0;background:var(--code-bg);padding:4px 6px;overflow:hidden}
.mg-term-host .xterm{height:100%}
.mg-term-hint{padding:4px 8px;color:var(--text-faint);font-size:11px}
/* The terminal strip's top edge: the same dimpled grip as the vertical dividers, rotated. */
.mg-term-grip{flex:0 0 8px;cursor:row-resize;position:relative;user-select:none;touch-action:none}
.mg-term-grip::after{content:"";position:absolute;left:0;right:0;top:3px;height:2px;background:var(--border-soft);border-radius:1px;transition:background .1s}
.mg-term-grip::before{content:"";position:absolute;left:50%;top:1px;margin-left:-9px;width:18px;height:4px;border-radius:2px;background:radial-gradient(circle,var(--text-faint) 1px,transparent 1px) center/6px 4px repeat-x;opacity:.7}
.mg-term-grip:hover::after,.mg-term-grip.dragging::after{background:var(--accent);top:2px;height:3px}
.mg-term-grip:hover::before,.mg-term-grip.dragging::before{opacity:1}
.mg-term-grip:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}
/* ---- right pane: commit header, file index, per-file cards ---- */
.mg-dh{background:var(--bg-elev);border-bottom:1px solid var(--border);padding:7px 9px;display:flex;flex-direction:column;gap:5px}
.mg-dh-subject{font-size:12.5px;font-weight:600;color:var(--text);white-space:pre-wrap;word-break:break-word}
.mg-dh-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font-size:11px;color:var(--text-dim)}
.mg-dh-body{margin:0;padding:5px 7px;background:var(--code-bg);border:1px solid var(--border-soft);border-radius:5px;color:var(--text-dim);font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;word-break:break-word;max-height:9em;overflow:auto}
.mg-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border:1px solid var(--border);border-radius:999px;background:var(--bg);font-family:var(--mono);font-size:10.5px;color:var(--text-dim);white-space:nowrap}
.mg-chip-add{color:var(--green);border-color:var(--green-soft,var(--border))}
.mg-chip-del{color:var(--red);border-color:var(--red-soft,var(--border))}
.mg-dindex{background:var(--bg);border-bottom:1px solid var(--border)}
.mg-dindex-head{padding:4px 9px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint);background:var(--bg-elev);border-bottom:1px solid var(--border-soft)}
.mg-drow{display:flex;align-items:center;gap:7px;width:100%;text-align:left;font:inherit;color:inherit;background:none;border:none;border-bottom:1px solid var(--border-soft);padding:3px 9px;cursor:pointer}
.mg-drow:hover{background:var(--bg-elev)}
.mg-drow.active{background:var(--accent-soft,var(--bg-elev));box-shadow:inset 2px 0 0 var(--accent)}
.mg-sbadge{flex:0 0 auto;min-width:13px;text-align:center;font-family:var(--mono);font-size:10px;font-weight:700;line-height:1.5;border:1px solid var(--border);border-radius:3px;color:var(--text-dim)}
.mg-sbadge.add{color:var(--green);border-color:var(--green-soft,var(--border))}
.mg-sbadge.del{color:var(--red);border-color:var(--red-soft,var(--border))}
.mg-sbadge.ren{color:var(--link)}
.mg-sbadge.bin{color:var(--amber)}
.mg-path{display:flex;align-items:baseline;gap:5px;min-width:0;flex:1 1 auto}
.mg-path-dir{font-family:var(--mono);font-size:11px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;min-width:0}
.mg-path-name{font-family:var(--mono);font-size:11.5px;color:var(--text);flex:0 0 auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-counts{margin-left:auto;display:flex;gap:6px;flex:0 0 auto;font-family:var(--mono);font-size:11px}
.mg-cadd{color:var(--green)}
.mg-cdel{color:var(--red)}
.mg-cbin{color:var(--text-faint)}
.mg-dsec{border-bottom:1px solid var(--border)}
.mg-dsec-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:7px;padding:4px 9px;background:var(--bg-elev);border-bottom:1px solid var(--border-soft)}
.mg-dsec-note{padding:2px 9px;font-family:var(--mono);font-size:10.5px;color:var(--text-faint);background:var(--bg);border-bottom:1px solid var(--border-soft)}
.mg-copy{flex:0 0 auto;border:1px solid var(--border);background:none;color:var(--text-faint);border-radius:4px;font:inherit;font-size:10px;padding:0 5px;cursor:pointer;opacity:0}
.mg-dsec-head:hover .mg-copy,.mg-copy:focus{opacity:1}
.mg-line-p{display:flex;gap:0;padding:0}
.mg-gut{flex:0 0 auto;display:flex;gap:6px;justify-content:flex-end;width:78px;padding:0 6px 0 8px;color:var(--text-faint);user-select:none;border-right:1px solid var(--border-soft)}
.mg-gut-o,.mg-gut-n{text-align:right}
.mg-code{flex:1 1 auto;min-width:0;padding:0 8px 0 7px;white-space:pre}
.mg-line-p.mg-line-add .mg-gut{color:var(--green)}
.mg-line-p.mg-line-del .mg-gut{color:var(--red)}
.mg-diff-body.mg-wrap .mg-code{white-space:pre-wrap;word-break:break-word}
.mg-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
/* ------------------------------------------------------------------ */
/* collapsible segments + the polish pass                              */
/* Headers are the navigation aid in every long view: sticky, bolder,  */
/* counted, and foldable (the folded set is persisted in prefs).       */
/* ------------------------------------------------------------------ */
.mg-seg{display:flex;align-items:center;gap:7px;width:100%;text-align:left;font:inherit;position:sticky;top:0;z-index:2;padding:6px 9px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text);background:var(--bg-elev2,var(--bg-elev));border:none;border-top:1px solid var(--border);border-bottom:1px solid var(--border);cursor:pointer}
.mg-seg:first-child{border-top:none}
.mg-seg:hover{background:var(--bg-elev3,var(--bg-elev))}
.mg-seg:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}
.mg-seg-chev{flex:0 0 auto;width:9px;color:var(--accent);font-size:10px;line-height:1}
.mg-seg-title{flex:0 0 auto;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-seg-note{font-weight:400;letter-spacing:0;text-transform:none;font-size:10.5px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.mg-seg-count{margin-left:auto;flex:0 0 auto;font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--text-dim);background:var(--chip-bg,var(--bg));border:1px solid var(--border);border-radius:999px;padding:0 6px}
.mg-seg.collapsed{border-bottom-color:var(--border-soft)}
.mg-seg-body{display:flex;flex-direction:column;min-width:0}
.mg-seg-sub{position:static;padding:4px 9px;font-size:10.5px;font-weight:600;letter-spacing:0;text-transform:none;background:var(--bg);border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft)}
/* Nested rows are indented under their header — the other way round put headers right of their content. */
.mg-seg-body-sub{padding-left:14px}
.mg-seg-sub .mg-seg-title{font-family:var(--mono);max-width:70%}
.mg-seg-sub .mg-seg-chev{width:8px}
.mg-seg-sub .mg-seg-count{background:none;border-color:transparent;padding:0}
/* ---- middle pane head: tabs read as a proper tab strip ---- */
.mg-pane-head{padding:6px 10px;background:var(--bg-elev,transparent)}
.mg-tab{border-radius:6px;padding:3px 9px}
.mg-tab.active{font-weight:600;box-shadow:inset 0 -2px 0 var(--accent);border-color:transparent;background:var(--chip-bg,var(--bg-elev))}
.mg-term-btn{padding:3px 9px;border-radius:6px}
.mg-diff-title{font-weight:600}
@media (max-width:900px){
  .mg-body{flex-direction:column}
  .mg-split{display:none}
  .mg-pane-fixed{flex:0 0 30%}
  .mg-pane{border-right:none;border-bottom:1px solid var(--border)}
}
`;

/** Terminal-strip sizing. TERM_DEFAULT/TERM_MIN mirror .mg-term's height and min-height in the CSS. */
const TERM_DEFAULT = 190;
const TERM_MIN = 120;
const TERM_MAX = 1200; // mirrors TERM_MAX in server/prefs.mjs (the storage-side bound)
const RESIZE_STEP = 20; // one arrow-key press, for the dividers and the terminal grip alike

/**
 * Terminal-strip height for a pointer position. The strip hangs off the bottom of the middle pane and
 * grows upward, so the height is just the distance from the pane's bottom edge up to the pointer.
 * Pure and exported on purpose: the test suite pins this arithmetic without a real pointer.
 */
export function termHeightFrom(pointerY, paneBottom, lo, hi) {
	const wanted = Math.round(Number(paneBottom) - Number(pointerY));
	if (!Number.isFinite(wanted)) return lo;
	return Math.min(hi, Math.max(lo, wanted));
}

export function createLayout(deps) {
	const {
	body, // from mount
	detailPane, // from mount
	detailHead, // from mount
	diffPane, // from mount
	fitTerm, // from mount
	reposPane, // from mount
	savePrefs, // from mount
	shortName, // from mount
	splitterCleanup, // from mount
	state, // from mount
	syncTerminal, // from mount
	termEl, // from mount
	termTitle, // from mount
	termToggle, // from mount
	} = deps;

	let splitDrag = null;
/* ---------------- layout: splitters ---------------- */
const MIN_PANE = 140;
const SPLIT_W = 9;
/**
 * How tall the strip may be: never under its own floor, never so tall that the list above it
 * disappears (one pane's worth of room is always kept). Falls back to the floor when the pane has
 * no measurable height yet — a freshly mounted view before layout, or a test double.
 */
function termBounds() {
	const lo = TERM_MIN;
	const paneH = Number(detailPane?.getBoundingClientRect?.().height ?? 0);
	// An unmeasured pane (first render, or a test double) leaves only the storage bound in place.
	const hi = Number.isFinite(paneH) && paneH > 0 ? Math.max(lo, Math.round(paneH - MIN_PANE)) : TERM_MAX;
	return [lo, hi];
}
// the middle pane must never shrink below its header (tabs + Term button)
const MIDDLE_MIN = Math.min(560, Math.max(300, Math.ceil((detailHead?.scrollWidth || 460) + 12)));

function applyLayout() {
	// The strip's height is only overridden once the user drags or arrows it; otherwise the
	// stylesheet's default applies, so a double-click reset really returns to the designed size.
	const termH = Number(state.prefs.termHeight);
	termEl.style.height = Number.isFinite(termH) && termH > 0 ? `${Math.round(termH)}px` : "";
	const widths = state.prefs.widths ?? [220, 300];
	reposPane.style.width = `${widths[0]}px`;
	diffPane.style.width = `${widths[1]}px`;
	detailPane.style.minWidth = `${MIDDLE_MIN}px`;
	const wantsTerm = state.prefs.termVisible === true;
	termEl.style.display = wantsTerm ? "" : "none";
	termToggle.classList.toggle("active", wantsTerm);
	termTitle.textContent = state.termActive
		? `terminal · ${shortName(state.termRepo ?? "")}${state.termExited ? " · exited" : ""}`
		: state.selectedRepo
			? `terminal · ${shortName(state.selectedRepo)}`
			: "terminal";
	syncTerminal();
}
function splitBounds(index, widths) {
	// repos + diff are pixel-fixed; the middle pane absorbs the remainder.
	// widths = [reposW, diffW] — the middle pane may not drop under its header width.
	const total = body.getBoundingClientRect().width || 1200;
	const other = index === 0 ? widths[1] : widths[0];
	const max = total - other - MIDDLE_MIN - SPLIT_W * 2;
	return [MIN_PANE, Math.max(MIN_PANE, max)];
}
function setupSplitter(split, index) {
	const onMove = (ev) => {
		if (splitDrag === null) return;
		ev.preventDefault();
		const rect = body.getBoundingClientRect();
		const widths = [...(state.prefs.widths ?? [220, 300])];
		const [lo, hi] = splitBounds(index, widths);
		if (index === 0) {
			widths[0] = Math.min(hi, Math.max(lo, ev.clientX - rect.left - SPLIT_W / 2));
		} else {
			widths[1] = Math.min(hi, Math.max(lo, rect.right - ev.clientX - SPLIT_W / 2));
		}
		state.prefs.widths = widths;
		applyLayout();
	};
	const onUp = () => {
		if (splitDrag === null) return;
		splitDrag = null;
		split.classList.remove("dragging");
		detach();
		void savePrefs({ widths: state.prefs.widths });
		fitTerm();
	};
	/** Detach the window listeners: a drag can end outside the window (or with the view gone). */
	function detach() {
		try {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		} catch {
			/* no window (tests) */
		}
	}
	splitterCleanup.push(detach);
	split.title = "Drag to resize · double-click to reset";
	// Double-click resets the layout: the quickest way back from a bad drag.
	split.addEventListener("dblclick", () => {
		state.prefs.widths = [220, 300];
		applyLayout();
		void savePrefs({ widths: state.prefs.widths });
	});
	split.addEventListener("pointerdown", (ev) => {
		ev.preventDefault();
		splitDrag = index;
		split.classList.add("dragging");
		try {
			split.setPointerCapture?.(ev.pointerId); // keeps the drag alive outside the window
		} catch {
			/* no pointer capture support */
		}
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	});
	// Focusable, so resizing does not require a pointer.
	split.tabIndex = 0;
	split.addEventListener("keydown", (ev) => {
		const delta = ev.key === "ArrowLeft" ? -RESIZE_STEP : ev.key === "ArrowRight" ? RESIZE_STEP : 0;
		if (!delta) return;
		ev.preventDefault?.();
		const widths = [...(state.prefs.widths ?? [220, 300])];
		const [lo, hi] = splitBounds(index, widths);
		widths[index] = Math.min(hi, Math.max(lo, widths[index] + delta));
		state.prefs.widths = widths;
		applyLayout();
		void savePrefs({ widths: state.prefs.widths });
		fitTerm();
	});
}

/**
 * The terminal strip's top edge. Dragging upward makes the strip taller (its height is the distance
 * from the pane's bottom edge up to the pointer), double-click restores the stylesheet's default, and
 * the arrow keys nudge it — the same affordances as the vertical dividers, on the other axis.
 */
function setupTermGrip(grip) {
	let dragging = false;
	/** Apply a height (clamped to the pane), keeping the pref and the terminal geometry in step. */
	const applyHeight = (next, persist) => {
		const [lo, hi] = termBounds();
		state.prefs.termHeight = Math.min(hi, Math.max(lo, Math.round(Number(next))));
		applyLayout();
		fitTerm();
		if (persist) void savePrefs({ termHeight: state.prefs.termHeight });
	};
	/** The height in effect right now: the stored one, or the stylesheet's default after a reset. */
	const currentHeight = () => {
		const h = Number(state.prefs.termHeight);
		return Number.isFinite(h) && h > 0 ? h : TERM_DEFAULT;
	};
	const onMove = (ev) => {
		if (!dragging) return;
		ev.preventDefault?.();
		const rect = detailPane?.getBoundingClientRect?.() ?? {};
		const [lo, hi] = termBounds();
		// Dragging up increases the height; below the floor it clamps to the floor.
		applyHeight(termHeightFrom(ev.clientY, rect.bottom ?? 0, lo, hi), false);
	};
	const onUp = () => {
		if (!dragging) return;
		dragging = false;
		grip.classList.remove("dragging");
		detach();
		void savePrefs({ termHeight: state.prefs.termHeight });
		fitTerm();
	};
	/** Detach the window listeners: a drag can end outside the window (or with the view gone). */
	function detach() {
		try {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		} catch {
			/* no window (tests) */
		}
	}
	splitterCleanup.push(detach);
	grip.tabIndex = 0;
	grip.title = "Drag to resize · double-click to reset · arrow keys move it";
	grip.addEventListener("dblclick", () => {
		state.prefs.termHeight = null; // null = no override: back to the stylesheet default
		applyLayout();
		fitTerm();
		void savePrefs({ termHeight: null });
	});
	grip.addEventListener("keydown", (ev) => {
		const delta = ev.key === "ArrowUp" ? RESIZE_STEP : ev.key === "ArrowDown" ? -RESIZE_STEP : 0;
		if (!delta) return;
		ev.preventDefault?.();
		applyHeight(currentHeight() + delta, true);
	});
	grip.addEventListener("pointerdown", (ev) => {
		ev.preventDefault?.();
		dragging = true;
		grip.classList.add("dragging");
		try {
			grip.setPointerCapture?.(ev.pointerId); // keeps the drag alive outside the window
		} catch {
			/* no pointer capture support */
		}
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	});
}

	return { applyLayout, setupSplitter, setupTermGrip, splitBounds };
}
