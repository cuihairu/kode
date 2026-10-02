import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it } from 'vitest';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import type { EntityDefinition } from '../src/codeGenerator';
import { parseDefDocument } from '../src/defParser';
import { analyzeDefDocument } from '../src/defAnalyzer';
import { validateDocument } from '../src/languageProviders';
import { languages } from './fake-vscode/languages';
import { makeTextDocument } from './fake-vscode/core';
import { workspaceState } from './fake-vscode/workspaceState';

// 批93「实体模板库(更多预设模板)」:预设模板 5→10,新增怪物/场景/公会/
// 队伍/邮件五个。除逐模板关键构造断言外,全库 10 个模板的生成产物两侧
// 全绿——语言侧实时诊断零条、defAnalyzer 建议零条:模板即示例,必须是
// 引擎可加载、校验无告警的 .def。断言先锁解析出 root,防解析失败导致
// 的「零诊断」空过。

const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
const internals = generator as unknown as {
  getTemplateEntity: (templateType: string) => EntityDefinition;
  generateDefContent: (entity: EntityDefinition) => string;
};

const NEW_TEMPLATES = ['monster', 'space', 'guild', 'team', 'mail'] as const;
const ALL_TEMPLATES = [
  'account', 'avatar', 'npc', 'item', 'monster', 'space', 'guild', 'team', 'mail', 'empty'
] as const;

beforeEach(() => {
  workspaceState.reset();
});

describe('新增预设模板(批93)', () => {
  it('5 个新模板均注册进 switch 且映射为各自实体(非空模板兜底)', () => {
    const emptyName = internals.getTemplateEntity('empty').config.name;

    for (const templateType of NEW_TEMPLATES) {
      const entity = internals.getTemplateEntity(templateType);

      expect(entity.config.name, templateType).not.toBe(emptyName);
      expect(entity.config.name.length, templateType).toBeGreaterThan(0);
      expect(typeof entity.config.hasBase, templateType).toBe('boolean');
      expect(typeof entity.config.hasCell, templateType).toBe('boolean');
      expect(typeof entity.config.hasClient, templateType).toBe('boolean');
      expect(entity.config.description, templateType).toBeTruthy();
    }
  });

  it('怪物模板:三域实体,生命/移动属性与攻防方法', () => {
    const def = internals.generateDefContent(internals.getTemplateEntity('monster'));

    expect(def).toContain('<monsterID>');
    expect(def).toContain('<hp>');
    expect(def).toContain('<Flags>CELL_PUBLIC_AND_OWN</Flags>');
    expect(def).toContain('<moveSpeed>');
    expect(def).toContain('<BaseMethods>');
    expect(def).toContain('<respawn>');
    expect(def).toContain('<takeDamage>');
    expect(def).toContain('<Arg>UINT32</Arg>');
    expect(def).toContain('<onMonsterDead>');
    expect(def).toContain('<Arg>UINT64</Arg>');
  });

  it('场景模板:ENTITYCALL 进出回调,无 ClientMethods 段', () => {
    const def = internals.generateDefContent(internals.getTemplateEntity('space'));

    expect(def).toContain('<spaceKey>');
    expect(def).toContain('<CellMethods>');
    expect(def).toContain('<Arg>ENTITYCALL</Arg>');
    expect(def).toContain('<onEnter>');
    expect(def).toContain('<onLeave>');
    expect(def).not.toContain('<ClientMethods>');
  });

  it('公会模板:公告字段与成员管理方法', () => {
    const def = internals.generateDefContent(internals.getTemplateEntity('guild'));

    expect(def).toContain('<guildName>');
    expect(def).toContain('<announcement>');
    expect(def).toContain('<DatabaseLength>256</DatabaseLength>');
    expect(def).toContain('<inviteMember>');
    expect(def).toContain('<kickMember>');
    expect(def).toContain('<onGuildLevelChanged>');
  });

  it('队伍模板:成员数组走引擎 ARRAY<of> 内联语法', () => {
    const def = internals.generateDefContent(internals.getTemplateEntity('team'));

    expect(def).toContain('<Type>ARRAY<of>UINT64</of></Type>');
    expect(def).toContain('<captainID>');
    expect(def).toContain('<maxMemberCount>');
    expect(def).toContain('<joinTeam>');
    expect(def).toContain('<leaveTeam>');
  });

  it('邮件模板:收发字段、已读状态与收件通知', () => {
    const def = internals.generateDefContent(internals.getTemplateEntity('mail'));

    expect(def).toContain('<senderName>');
    expect(def).toContain('<receiverID>');
    expect(def).toContain('<isRead>');
    expect(def).toContain('<markRead>');
    expect(def).toContain('<deleteMail>');
    expect(def).toContain('<onMailReceived>');
  });
});

describe('全库模板产物双侧全绿(10 模板)', () => {
  it.each(ALL_TEMPLATES)('%s 模板生成 .def 过实时诊断与静态建议零命中', templateType => {
    const def = internals.generateDefContent(internals.getTemplateEntity(templateType));

    // 防空过:解析失败(parseDefAst 返 null)会让两侧检查静默早退成「零命中」
    expect(parseDefDocument(def).root, `${templateType} 应解析出 root`).not.toBeNull();

    const document = makeTextDocument(def, { fileName: `/tmp/kode-template-${templateType}.def` });
    const collection = languages.createDiagnosticCollection(`template-${templateType}`);
    validateDocument(document as never, collection as never);
    expect(collection.get(document.uri), `${templateType} 实时诊断`).toEqual([]);

    expect(analyzeDefDocument(def), `${templateType} 静态建议`).toEqual([]);
  });
});
