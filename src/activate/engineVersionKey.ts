/**
 * 索引缓存/断点的版本淘汰键(2026-11-18 用户报「一直在扫」,巡检单故障 B)。
 *
 * 只取活动 profile 的**引擎 API 主版本**作键:引擎换大版本,符号确实变,
 * 缓存必须弃用;同 major 不同 minor/patch 不弃用。扩展自身版本号
 * (packageJSON.version,nightly 每次滚动)不再参与判定——它在每次启动都
 * 把缓存判成「版本不符」,于是每次都从零全扫。仍写进 meta 供溯源,只是
 * 不当淘汰键。
 */

import type * as vscode from 'vscode';
import { engineMajorOf } from '../backend/engineApiMetadata';
import { resolveActiveProfile } from '../activeProfile';

/** 活动 profile 的引擎主版本键;无活动 profile / 引擎根未记录 / 读不出宏 → '' */
export function activeProfileEngineMajor(memento?: vscode.Memento): string {
  const profile = resolveActiveProfile(memento);
  return profile ? engineMajorOf(profile.engineRoot) : '';
}