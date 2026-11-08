/** 全局指令（内置层只读）。Owner: lane H。 */
import { useState } from 'react';
import { InstructionWorkbench } from '../../components/admin/InstructionWorkbench';
import { Page, PageHeader, Tabs } from '../../components/ui';

export function InstructionsPage() {
  const [scope, setScope] = useState<'global' | 'builtin'>('global');
  return (
    <Page wide>
      <PageHeader title="全局指令" sub="所有书共用的指令层。层序：内置 → 全局 → 题材 → 书层；书层最后加载、优先级最高。" />
      <Tabs
        value={scope}
        onChange={setScope}
        tabs={[
          { id: 'global', label: '全局层' },
          { id: 'builtin', label: '内置（只读）' },
        ]}
      />
      <InstructionWorkbench key={scope} scope={scope} />
    </Page>
  );
}
