; Pylume NSIS 安装钩子（Tauri installerHooks 扩展点，见 docs/disk-space-plan.md P2）。
; 使用官方 NSIS 模板，不 fork 完整 installer.nsi。
;
; 卸载时「是否删除用户数据」不再单独弹 MessageBox，而是复用 Tauri 官方模板卸载确认页上
; 自带的「Delete the application data」复选框，消除「勾了复选框却仍被二次询问」的重复打扰：
;   - 模板 un.ConfirmLeave 经 BM_GETCHECK 把勾选状态写入全局变量 $DeleteAppDataCheckboxState
;     （1 = 勾选；与模板内删除 ${BUNDLEID} 目录用的是同一变量）；
;   - 更新模式（$UpdateMode = 1，升级重装先卸载旧版）下不删数据，与模板内置逻辑一致。
;
; 耦合说明：$DeleteAppDataCheckboxState / $UpdateMode 是 Tauri 官方 installer.nsi 的内部全局变量，
; 升级 Tauri 时需对照官方模板确认变量名与取值语义未变（docs/data-directory-layout-v2.md §7）。
;
; 数据根可能被迁移到自定义位置（指针文件机制，跨平台、无注册表依赖）：
;   - 指针文件：%APPDATA%\Pylume\data-root（应用写入，内容 = 数据根绝对路径，无换行）
;   - 默认数据根：%LOCALAPPDATA%\Pylume
; 勾选删除数据时需同时清理：默认根 + 指针所指根 + 指针目录本身。
; 用户工具链（uv / pyrefly 所在目录）一律不碰。

!macro NSIS_HOOK_POSTUNINSTALL
  Push $0
  Push $1
  Push $2
  Push $3
  ; 复用卸载确认页复选框状态：未勾选（$DeleteAppDataCheckboxState != 1）或更新模式即跳过。
  StrCmp $DeleteAppDataCheckboxState 1 0 pylume_skip_data_removal
  StrCmp $UpdateMode 1 pylume_skip_data_removal
    ; 1) 默认数据根
    RMDir /r "$LOCALAPPDATA\Pylume"
    ; 2) 迁移过的数据根：读指针文件（应用自己写入的，内容 = 数据根绝对路径）。
    ;    注意：不碰注册表——PYLUME_DATA_ROOT 环境变量是用户自有配置（文档化的高级用法），
    ;    应用从不写入，卸载器也不得删除。
    ClearErrors
    FileOpen $0 "$APPDATA\Pylume\data-root" r
    IfErrors pylume_pointer_done
    FileRead $0 $1
    FileClose $0
    StrCmp $1 "" pylume_pointer_done
    ; 安全护栏：路径过短或以 \ 结尾（盘根，如 D:\）绝不递归删除
    StrLen $2 $1
    IntCmp $2 4 pylume_pointer_done pylume_pointer_done 0
    StrCpy $3 $1 1 -1
    StrCmp $3 "\" pylume_pointer_done
      RMDir /r "$1"
    pylume_pointer_done:
    ; 3) 指针目录本身（含指针文件）
    RMDir /r "$APPDATA\Pylume"
  pylume_skip_data_removal:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend