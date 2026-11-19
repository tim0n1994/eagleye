/** Curated writing presets. Only display metadata is sent to the browser. */

const DEFAULT_STYLE = 'personal';

const styles = new Map([
  [DEFAULT_STYLE, {
    label: { zh: '个人偏好（默认）', en: 'Personal preferences (default)' },
    description: { zh: '按你的写作偏好与认可的样本组织新稿。', en: 'Use your preferences and approved samples to shape new drafts.' },
  }],
  ['funeralai-observer', {
    label: { zh: '葬AI · 锐评观察', en: 'FuneralAI · Sharp observation' },
    description: {
      zh: '从一个反常细节起笔，换个角度看它，再用具体证据把判断讲透。语气口语、有锋芒，留一点冷幽默。',
      en: 'Open with an odd detail, change the question, and follow the evidence to a pointed judgment. Conversational, with a little dry humor.',
    },
    reference_url: 'https://funeralai.cc/articles/',
    prompt: [
      '行文风格：锐评观察。这个预设只规定叙事和语气。事实约束与作者本次想说、批注优先；作者的明确偏好优先于预设建议。本人样本决定用词和口吻，预设帮助组织叙事。',
      '先在内部想清楚三件事：读者原本会怎么理解？哪条具体证据改变了这层理解？这对某个实际的人、任务或场景意味着什么？只用素材能支撑的部分。选一条主线，能推动同一个判断的素材才进入正文，其余可以省下。',
      '起笔先给具体抓手：一个令人停顿的功能细节、数字反差、失败步骤、真实场景，或作者有依据的一句直判。顺势交代为什么值得往下看。标题写出那个具体矛盾或判断，少下比证据更响的结论。',
      '从素材里挑最合适的推进方式。实测型沿着承诺、操作、结果推进，用耗时、人工接管、失败边界等重新定义“能用”。行业型从异常信号追到账面指标、真实用途、组织或生意上的取舍，并解释中间的因果依据。观察型从可见的小事逐步放大，沿一条出乎意料但确有关系的比较去找尺度。素材少时，写清一个细节和它带来的问题即可。',
      '判断写在证据边上。先交代观察到什么，再说解释或疑问。比较时把双方放进同一个任务、成本或条件里。允许一个产品在两种场景得到不同评价；有反例就让判断转一下。有评论才把相应判断写作作者的“我”；来源里的测试和访问仍归给来源。',
      '短段落各做一件事。用正常长句把过程说清，再用偶尔一两句单独的短段落落下判断。转折来自新证据或新标尺。口语可以松一点；用具体反差、轻微反讽或自嘲提味，解释完就收。避免成串的热梗、固定口头禅、人身挖苦、假装做过测试，避免比喻盖过事实。',
      '结尾可以回到开头的数字、动作或承诺，指出它现在意味着什么；也可以留一个有具体判别条件的问号。省去万能展望、总结模板和硬凑的互动号召。',
      '公众号写出主线走过的证据和转折。小红书重排阅读顺序：首图给一个让人停下的细节，后面的图卡各带来一条新证据或推进一层判断，末图给这个问题的落点。篇幅短时合并动作，保留原有图卡来源约束。',
      '最后默读：删掉换个选题也能用的段落。检查俏皮话下面是否还有事实，结论是否出自这个作者的素材或批注。风格参考中的人名、经历、说法与行业故事不能作为新稿素材，也不要以参考作者身份发言。',
    ].join('\n'),
  }],
]);

function hasStyle(id) {
  return styles.has(id);
}

function listStyles() {
  return Array.from(styles, ([id, { label, description, reference_url }]) => ({ id, label, description, reference_url }));
}

function stylePrompt(id) {
  return styles.get(id)?.prompt || '';
}

module.exports = { DEFAULT_STYLE, hasStyle, listStyles, stylePrompt };
