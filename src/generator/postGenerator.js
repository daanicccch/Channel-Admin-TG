const aiProvider = require('../ai/aiProvider');
const logger = require('../utils/logger');
const styleEngine = require('./styleEngine');
const formatBuilder = require('./formatBuilder');
const mediaHandler = require('./mediaHandler');
const postStore = require('../utils/postStore');
const { inferMediaTypeFromPath } = require('../utils/mediaUtils');

const MAX_RETRIES = 2;
const CAPTION_SAFE_TEXT_LIMIT = parseInt(process.env.TG_CAPTION_SAFE_TEXT_LIMIT || '900', 10);
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{2B50}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]/gu;
const SOURCE_STOP_WORDS = new Set([
  'это', 'как', 'что', 'или', 'для', 'the', 'and', 'with', 'from', 'that', 'this', 'have', 'will',
  'post', 'news', 'today', 'обзор', 'дайджест', 'рынок', 'канал', 'канале', 'поста', 'текст',
  'очень', 'если', 'после', 'между', 'почему', 'когда', 'where', 'what', 'about', 'your',
  'telegram', 'gift', 'gifts', 'channel', 'который', 'которая', 'которые', 'сегодня',
  'просто', 'снова', 'теперь', 'самый', 'самая', 'самое', 'более', 'может', 'нужно',
]);

class PostGenerator {
  async generatePost(type, analysisData, profile = null) {
    const {
      clusters = [],
      webData = {},
      sentiment = {},
      trends = [],
      leadMediaOverride = null,
      recentTargetPosts = [],
      sourceExclusions = null,
    } = analysisData || {};
    const enforceCaptionForSourceMedia = ['post', 'alert'].includes(type);
    const profileId = profile?.id || analysisData?.profileId || 'default';
    let leadMediaCandidate = leadMediaOverride || mediaHandler.selectLeadMediaPost(clusters, '', {
      profileId: profileId || null,
      excludedSourceKeys: sourceExclusions?.excludedSourceKeys || [],
      excludedSourcePosts: sourceExclusions?.excludedSourcePosts || [],
      excludedMediaPaths: sourceExclusions?.excludedMediaPaths || [],
      excludedMediaHashes: sourceExclusions?.excludedMediaHashes || [],
    });
    let sourceContext = this._buildSourceContext(leadMediaCandidate, clusters);
    const recentPosts = postStore.getRecentPosts(profileId, 12);
    const targetRecentPosts = Array.isArray(recentTargetPosts) ? recentTargetPosts : [];
    const triedSourceKeys = new Set([leadMediaCandidate?.sourceKey].filter(Boolean));

    const rulesContent = styleEngine.loadRules(profile);
    const templatesContent = styleEngine.loadTemplates(profile);
    const humanizerRulesContent = styleEngine.loadHumanizerRules(profile);
    let effectiveRulesContent = this._buildEffectiveRules(type, rulesContent, leadMediaCandidate, sourceContext);
    let prompt = this._buildPrompt(
      type,
      effectiveRulesContent,
      templatesContent,
      humanizerRulesContent,
      sourceContext.clustersForPrompt,
      webData,
      sentiment,
      trends,
      leadMediaCandidate,
      sourceContext,
      enforceCaptionForSourceMedia,
      recentPosts,
      profileId,
    );

    let result = null;
    let validationResult = null;
    let attempts = 0;

    while (attempts <= MAX_RETRIES) {
      try {
        if (attempts === 0 || !result || !validationResult?.issues?.length) {
          result = await aiProvider.generateJSON(prompt, { temperature: 0.55 });
        } else {
          const fixPrompt = this._buildFixPrompt(
            result,
            validationResult.issues,
            type,
            effectiveRulesContent,
            humanizerRulesContent,
            leadMediaCandidate,
            enforceCaptionForSourceMedia,
            recentPosts,
            profileId,
          );
          result = await aiProvider.generateJSON(fixPrompt, { temperature: 0.2 });
        }

        result.text = this._enforceEmojiLimit(result.text || '', 2);
      } catch (err) {
        logger.error(`PostGenerator: AI generation failed (attempt ${attempts + 1}) - ${err.message}`);
        attempts++;
        continue;
      }

      const postText = result.text || '';
      validationResult = styleEngine.validatePost(postText, type);
      validationResult = this._appendCaptionIssue(
        validationResult,
        postText,
        enforceCaptionForSourceMedia ? leadMediaCandidate : null,
      );
      validationResult = this._appendSourceAlignmentIssue(
        validationResult,
        postText,
        leadMediaCandidate ? sourceContext : null,
      );
      validationResult = this._appendSimilarityIssue(
        validationResult,
        postText,
        profileId,
        type,
        [...recentPosts, ...targetRecentPosts],
        sourceContext,
      );

      if (!validationResult.valid && this._hasSimilarityIssue(validationResult)) {
        const alternativeLeadMediaCandidate = mediaHandler.selectAlternativeLeadMediaPost(
          clusters,
          [...triedSourceKeys],
          postText,
          {
            profileId,
            excludedSourceKeys: sourceExclusions?.excludedSourceKeys || [],
            excludedSourcePosts: sourceExclusions?.excludedSourcePosts || [],
            excludedMediaPaths: sourceExclusions?.excludedMediaPaths || [],
            excludedMediaHashes: sourceExclusions?.excludedMediaHashes || [],
            currentSourceKey: leadMediaCandidate?.sourceKey || '',
            currentMediaPaths: leadMediaCandidate?.paths || [],
            currentChannel: leadMediaCandidate?.channel || '',
          },
        );

        if (!alternativeLeadMediaCandidate && leadMediaOverride) {
          logger.warn('PostGenerator: similarity retry exhausted without a non-rejected alternative source');
          break;
        }

        if (alternativeLeadMediaCandidate?.sourceKey) {
          triedSourceKeys.add(alternativeLeadMediaCandidate.sourceKey);
          leadMediaCandidate = alternativeLeadMediaCandidate;
          sourceContext = this._buildSourceContext(leadMediaCandidate, clusters);
          effectiveRulesContent = this._buildEffectiveRules(type, rulesContent, leadMediaCandidate, sourceContext);
          prompt = this._buildPrompt(
            type,
            effectiveRulesContent,
            templatesContent,
            humanizerRulesContent,
            sourceContext.clustersForPrompt,
            webData,
            sentiment,
            trends,
            leadMediaCandidate,
            sourceContext,
            enforceCaptionForSourceMedia,
            recentPosts,
            profileId,
          );
          result = null;
          logger.info(
            `PostGenerator: similarity detected, switched source to ${leadMediaCandidate.channel} post=${leadMediaCandidate.telegramPostId}`,
          );
        }
      }

      if (validationResult.valid) {
        logger.info(`PostGenerator: post type "${type}" passed validation (attempt ${attempts + 1})`);
        break;
      }

      logger.warn(`PostGenerator: validation failed (attempt ${attempts + 1}): ${validationResult.issues.join('; ')}`);
      attempts++;
    }

    if (!result || !result.text) {
      logger.error('PostGenerator: failed to generate post after all retries');
      throw new Error(`PostGenerator: failed to generate ${type} for profile=${profileId}`);
    }

    const formattedText = this._applySourceCustomEmojiMarkup(
      formatBuilder.buildTelegramHTML(result.text),
      leadMediaCandidate,
    );

    let media = { type: 'none', path: null, paths: [] };
    if (leadMediaCandidate) {
      const sourcePaths = Array.isArray(leadMediaCandidate.paths)
        ? leadMediaCandidate.paths.filter(Boolean).slice(0, 10)
        : [leadMediaCandidate.path].filter(Boolean);

      media = {
        type: leadMediaCandidate.mediaType || inferMediaTypeFromPath(sourcePaths[0]),
        path: sourcePaths[0] || null,
        paths: sourcePaths,
      };

      logger.info(
        `PostGenerator: source-first media selected from ${leadMediaCandidate.channel} post=${leadMediaCandidate.telegramPostId} count=${sourcePaths.length}`,
      );
    } else {
      logger.info('PostGenerator: no reliable source image found, sending text-only');
    }

    return {
      text: formattedText,
      media,
      keyboard: [],
      hashtags: result.hashtags || '',
      postType: result.post_type || type,
      _leadMediaCandidate: leadMediaCandidate,
      _eventFingerprint: sourceContext?.eventFingerprint || null,
      _profileId: profileId,
      _profileTitle: profile?.title || 'Default channel',
      _targetChannelId: profile?.telegramChannelId || '',
    };
  }

  _buildEffectiveRules(type, rulesContent, leadMediaCandidate, sourceContext) {
    let effectiveRulesContent = rulesContent;

    if (leadMediaCandidate) {
      effectiveRulesContent += `\n\n## Source-first mode\n- Rewrite only the exact source post tied to the image.\n- Do not mix another story from the cluster.\n- Text and image must describe the same event.\n- Anchor keywords: ${JSON.stringify(sourceContext?.anchorKeywords || [])}`;
    }

    if (type === 'weekly') {
      effectiveRulesContent += '\n\n## Weekly mode\n- Summarize the strongest events from the last 7 days.\n- Use 2-4 distinct events if enough data exists.\n- Do not turn one single event into a fake weekly overview.\n- If the input only has one real event, frame it as the main event of the week and keep the post compact.\n- Keep temporal sanity: if an item appeared for a holiday or was removed within 1-2 days, describe it as a short-lived event, not as a historic tragedy or permanent loss.\n- Do not invent permanence, collector panic, or long-term market meaning unless the source explicitly states it.';
    }

    return effectiveRulesContent;
  }

  _buildPrompt(
    type,
    rulesContent,
    templatesContent,
    humanizerRulesContent,
    clusters,
    webData,
    sentiment,
    trends,
    leadMediaCandidate,
    sourceContext = null,
    enforceCaptionForSourceMedia = false,
    recentPosts = [],
    profileId = 'default',
  ) {
    const typeNames = {
      digest: 'Дайджест (утро/вечер)',
      analysis: 'Аналитика',
      alert: 'Алерт',
      weekly: 'Недельный дайджест',
    };

    const typeName = ({
      post: 'Обычный пост',
      alert: 'Алерт',
      weekly: 'Недельный пост',
    })[type] || typeNames[type] || type;
    const compactClusters = this._compactClusters(clusters);
    const compactWebData = this._compactValue(webData, 0, 10);
    const compactSentiment = this._compactValue(sentiment, 0, 8);
    const compactTrends = this._compactValue(trends, 0, 8);
    const compactLeadMedia = leadMediaCandidate ? {
      channel: leadMediaCandidate.channel,
      telegramPostId: leadMediaCandidate.telegramPostId,
      views: leadMediaCandidate.views,
      origin: leadMediaCandidate.origin,
      mediaCount: Array.isArray(leadMediaCandidate.paths) ? leadMediaCandidate.paths.length : 1,
      sourceText: this._truncateText(leadMediaCandidate.text, 700),
    } : null;
    const sourceVisibleLength = formatBuilder.getTelegramVisibleText(leadMediaCandidate?.text || '').length;
    const sourceFocusInstruction = leadMediaCandidate
      ? `\nSOURCE-FIRST MODE:\nYou are rewriting exactly one source-post with image(s). Do not mix in another story from the cluster. Text and media must describe the same event.\nAnchor keywords: ${JSON.stringify(sourceContext?.anchorKeywords || [])}\n`
      : '\n';
    const captionConstraintInstruction = (leadMediaCandidate && enforceCaptionForSourceMedia)
      ? `\nCAPTION MODE:\nThis source-post will be published with media in a single Telegram caption. Keep the visible text within ${CAPTION_SAFE_TEXT_LIMIT} chars.\n`
      : '\n';
    const sourceLengthInstruction = leadMediaCandidate
      ? `\nLENGTH CONTROL:\nThe source post is about ${sourceVisibleLength} visible chars long.\nTarget roughly the same length: stay close to the source, usually within minus 15% to plus 15%.\nDo not inflate a short source into a long article.\nIf the source is brief, keep the rewrite brief.\n`
      : '\n';
    const weeklyInstruction = type === 'weekly'
      ? `\nWEEKLY MODE:\nThis post must summarize the strongest events from the last 7 days, not expand one single case into an article.\nUse 2-4 distinct events if enough data exists.\nIf there is only one real event in the input, keep the post short and frame it as the main event of the week.\nKeep temporal sanity: if something appeared for a holiday and disappeared within 1-2 days, describe it plainly as a short-lived event.\nDo not turn a brief removal into tragedy, legend, or irreversible loss unless the source explicitly confirms permanence.\n`
      : '\n';
    const typeBehaviorInstruction = this._getTypeBehaviorInstruction(type);
    const memoryPrompt = postStore.buildMemoryPrompt(profileId, type, sourceContext?.anchorKeywords || []);

    return `Ты — редактор Telegram-канала о крипте. Тема поста определяется правилами канала, кластерами новостей, подключёнными каналами и веб-данными.

ПРАВИЛА НАПИСАНИЯ ПОСТОВ:
${rulesContent || 'Правила не загружены. Пиши в стиле информативного Telegram-канала.'}

ШАБЛОНЫ ПОСТОВ:
${templatesContent || 'Шаблоны не загружены.'}

ПРАВИЛА ОЧЕЛОВЕЧИВАНИЯ:
${humanizerRulesContent || 'Сделай текст живым, конкретным и естественным, без канцелярита и рекламных штампов.'}

ЗАДАНИЕ:
Напиши пост типа: ${typeName}
Используй шаблон для этого типа поста из раздела "ШАБЛОНЫ ПОСТОВ" выше.
Текст должен звучать как живой пост в Telegram, а не как пресс-релиз или нейтральная заметка.
${typeBehaviorInstruction}${sourceFocusInstruction}${captionConstraintInstruction}${sourceLengthInstruction}${weeklyInstruction}
ДАННЫЕ ДЛЯ ПОСТА:

Кластеры новостей:
${JSON.stringify(compactClusters, null, 2)}

Веб-данные:
${JSON.stringify(compactWebData, null, 2)}

Настроение рынка:
${JSON.stringify(compactSentiment, null, 2)}

Тренды:
${JSON.stringify(compactTrends, null, 2)}

Опорный source-post с картинкой:
${JSON.stringify(compactLeadMedia, null, 2)}

НЕДАВНИЕ ПОСТЫ ЭТОГО КАНАЛА:
${memoryPrompt}

ТРЕБОВАНИЯ К ОТВЕТУ:
Верни JSON-объект со следующими полями:
{
  "text": "полный текст поста с HTML-разметкой для Telegram",
  "media_suggestion": "описание подходящего изображения для поста или null",
  "hashtags": "хештеги через пробел",
  "post_type": "${type}"
}

Важно:
- Пиши только на русском языке
- Используй 1-2 эмодзи на весь пост
- Если дан source-post с картинкой, перепиши именно его фактическое ядро в новом тоне, а не уходи в другую тему
- Если дан source-post с картинкой для короткого формата post/alert, текст должен помещаться в одну Telegram caption, цель: не более ${CAPTION_SAFE_TEXT_LIMIT} символов
- Не начинай пост с "Друзья", "Итак", "Добрый день"
- Не используй фразы: "в данной статье", "следует отметить", "как мы все знаем", "безусловно", "резюмируя", "guaranteed", "to the moon"
- Не выдумывай новые факты, ссылки, цифры и источники
- Если во входном source-post есть рекламный футер, навигация по каналам, market/buy-sell ссылки, рефки или промо-блок, не переноси это в пост
- Из ссылок оставляй только те, которые реально нужны по смыслу поста: например addemoji, addstickers, конкретный post/model/nft link
- Не делай отдельный список ссылок, если это не нужно для смысла поста
- Не повторяй недавний пост по заголовку, первой подводке, углу и ключевой мысли
- Если тема пересекается с недавним постом, смени угол: alert = сигнал, post = суть и контекст без воды, weekly = место события в неделе
- Если свежие timestamped веб-данные конфликтуют со старыми постами, опирайся на более свежие данные
- Не сравнивай старые и новые метрики без точной даты или явного таймфрейма из источника
- Сохраняй фактуру входных данных и не уводи пост в сторону от главной темы входного набора
- Соблюдай лимиты длины для типа "${type}"
- Верни только JSON, без дополнительного текста`;
  }

  _buildFixPrompt(previousResult, issues, type, rulesContent, humanizerRulesContent, leadMediaCandidate, enforceCaptionForSourceMedia, recentPosts = [], profileId = 'default') {
    const mediaModeHint = leadMediaCandidate
      ? (
        enforceCaptionForSourceMedia
          ? `Если сохраняется опорный source-post с картинкой, ужми текст до ${CAPTION_SAFE_TEXT_LIMIT} символов и верни фокус к фактическому ядру этого source-post.`
          : 'Если сохраняется опорный source-post с картинкой, верни фокус к фактическому ядру этого source-post и не уводи текст от визуала.'
      )
      : 'Если текст слишком раздут, ужми его без потери основных фактов.';
    const numberLayoutHint = 'Если в посте есть офферы, сумма сделки, потеря или две валюты для одного и того же факта, не ставь их голыми строками друг под другом. Собирай в один читаемый блок: `— 100 000 ⭐️ (~1 400 TON)`.';
    const memoryPrompt = postStore.buildMemoryPrompt(profileId, type, []);

    return `Предыдущая версия поста не прошла валидацию. Исправь следующие проблемы:

Проблемы:
${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

Предыдущий текст поста:
${previousResult.text || ''}

Правила постов:
${rulesContent || ''}

Правила очеловечивания:
${humanizerRulesContent || ''}

Недавние посты:
${memoryPrompt}

Тип поста: ${type}

Исправь текст так, чтобы он звучал как живой пост редактора, а не как AI-черновик. Сохрани факты, цифры, HTML-теги и общий смысл. Если в тексте больше двух эмодзи, убери лишние. Не повторяй недавние посты по заголовку, первой подводке и углу. ${mediaModeHint} ${numberLayoutHint} Если есть сравнение старой и новой метрики без точной даты или явного таймфрейма, убери такое сравнение.

Верни JSON-объект с полями:
{
  "text": "исправленный текст поста",
  "media_suggestion": ${JSON.stringify(previousResult.media_suggestion ?? null)},
  "hashtags": ${JSON.stringify(previousResult.hashtags || '')},
  "post_type": "${type}"
}

Верни только JSON, без дополнительного текста.`;
  }

  _getTypeBehaviorInstruction(type) {
    const instructions = {
      alert: `\nTYPE BEHAVIOR:\nalert = the fastest signal.\n- Lead with one fresh trigger or hint.\n- Keep it compact and punchy.\n- Do not state that implementation is finished unless the source confirms it.\n- Shape: signal -> why people noticed -> short watchline.\n`,
      post: `\nTYPE BEHAVIOR:\npost = the default rewritten post.\n- Explain what happened and what is already known now.\n- Keep the body tight and proportional to the source.\n- Add context only when it is directly supported by the input.\n- Never pad a short source just to make it feel bigger.\n`,
      weekly: `\nTYPE BEHAVIOR:\nweekly = selective recap.\n- Connect events into the picture of the week.\n- No alert-style framing.\n- Each block must justify why it made the week.\n`,
    };

    return instructions[type] || '\n';
  }

  _compactClusters(clusters) {
    return (Array.isArray(clusters) ? clusters : [])
      .slice(0, 5)
      .map((cluster, index) => ({
        rank: index + 1,
        topic: cluster.topic || '',
        summary: this._truncateText(cluster.summary, 260),
        keyFacts: Array.isArray(cluster.keyFacts)
          ? cluster.keyFacts.slice(0, 4).map((fact) => this._truncateText(fact, 180))
          : [],
        sources: Array.isArray(cluster.sources) ? cluster.sources.slice(0, 5) : [],
        viewsTotal: cluster.viewsTotal || 0,
        postCount: cluster.postCount || (Array.isArray(cluster.postIds) ? cluster.postIds.length : 0),
      }));
  }

  _compactValue(value, depth = 0, limit = 8) {
    if (value == null) {
      return value;
    }

    if (typeof value === 'string') {
      return this._truncateText(value, 280);
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (depth >= 3) {
      if (Array.isArray(value)) {
        return value
          .slice(0, Math.min(limit, 5))
          .map((item) => this._compactValue(item, depth + 1, 5));
      }

      return Object.fromEntries(
        Object.entries(value)
          .slice(0, Math.min(limit, 6))
          .map(([key, nestedValue]) => [key, this._compactValue(nestedValue, depth + 1, 5)]),
      );
    }

    if (Array.isArray(value)) {
      return value
        .slice(0, limit)
        .map((item) => this._compactValue(item, depth + 1, Math.max(4, limit - 2)));
    }

    return Object.fromEntries(
      Object.entries(value)
        .slice(0, limit)
        .map(([key, nestedValue]) => [key, this._compactValue(nestedValue, depth + 1, Math.max(4, limit - 2))]),
    );
  }

  _truncateText(value, maxLength = 280) {
    const text = String(value || '');
    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  _appendCaptionIssue(validationResult, postText, leadMediaCandidate) {
    const visibleLength = formatBuilder.getTelegramEntityLength(postText);
    if (!leadMediaCandidate || visibleLength <= CAPTION_SAFE_TEXT_LIMIT) {
      return validationResult;
    }

    const issues = [
      ...(validationResult?.issues || []),
      `Текст не помещается в подпись к одному source-post: ${visibleLength} символов при целевом лимите ${CAPTION_SAFE_TEXT_LIMIT}`,
    ];

    return {
      valid: false,
      issues: [...new Set(issues)],
    };
  }

  _appendSourceAlignmentIssue(validationResult, postText, sourceContext) {
    if (!sourceContext?.leadMediaCandidate || !sourceContext?.anchorKeywords?.length) {
      return validationResult;
    }

    const normalized = this._normalizeForKeywordMatch(postText);
    const overlaps = sourceContext.anchorKeywords.filter((keyword) => normalized.includes(keyword));
    const minRequired = Math.min(2, sourceContext.anchorKeywords.length);
    if (overlaps.length >= minRequired) {
      return validationResult;
    }

    return {
      valid: false,
      issues: [...new Set([
        ...(validationResult?.issues || []),
        `Текст с картинкой слабо совпадает с source-post: найдено ${overlaps.length} ключевых маркеров из ${sourceContext.anchorKeywords.length}`,
      ])],
    };
  }

  _appendSimilarityIssue(validationResult, postText, profileId, type, recentPosts = [], sourceContext = null) {
    const issues = Array.isArray(validationResult?.issues) ? [...validationResult.issues] : [];
    const similarPost = postStore.findSimilarPost(postText, profileId, type, {
      publishedOnly: true,
      withinHours: 72,
      currentEventFingerprint: sourceContext?.eventFingerprint || null,
      currentSourceKey: sourceContext?.leadMediaCandidate?.sourceKey || '',
      currentMediaPaths: sourceContext?.leadMediaCandidate?.paths || [],
    });

    if (similarPost) {
      issues.push(
        `Text is too close to a recently published post [${similarPost.type}] "${similarPost.title}" (similarity=${similarPost.score.toFixed(2)}${similarPost.sameSourceKey ? ', same_source=true' : ''}${similarPost.sameMedia ? ', same_media=true' : ''}${similarPost.eventType ? `, event=${similarPost.eventType}` : ''}). Need a different angle/source and different media for the last 3 days.`
      );
    }

    return {
      valid: issues.length === 0,
      issues: [...new Set(issues)],
    };
  }

  _hasSimilarityIssue(validationResult) {
    return Array.isArray(validationResult?.issues) &&
      validationResult.issues.some((issue) => String(issue || '').toLowerCase().includes('similarity='));
  }

  _buildSourceContext(leadMediaCandidate, clusters = []) {
    if (!leadMediaCandidate) {
      return {
        leadMediaCandidate: null,
        clustersForPrompt: Array.isArray(clusters) ? clusters : [],
        anchorKeywords: [],
        eventFingerprint: null,
      };
    }

    const sourceCluster = this._findSourceCluster(clusters, leadMediaCandidate);

    return {
      leadMediaCandidate,
      clustersForPrompt: sourceCluster ? [sourceCluster] : [],
      anchorKeywords: this._extractAnchorKeywords(leadMediaCandidate.text),
      eventFingerprint: postStore.buildEventFingerprint({
        text: leadMediaCandidate.text,
        topic: sourceCluster?.topic || '',
        summary: sourceCluster?.summary || '',
        keyFacts: sourceCluster?.keyFacts || [],
        entities: this._extractAnchorKeywords(leadMediaCandidate.text),
      }),
    };
  }

  _extractAnchorKeywords(text) {
    return [...new Set(
      this._normalizeForKeywordMatch(text)
        .split(/\s+/)
        .map((word) => word.trim())
        .filter((word) => word.length >= 4 && !SOURCE_STOP_WORDS.has(word))
    )].slice(0, 8);
  }

  _normalizeForKeywordMatch(text) {
    return String(text || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  _findSourceCluster(clusters, leadMediaCandidate) {
    const list = Array.isArray(clusters) ? clusters : [];
    const sourceKey = String(leadMediaCandidate?.sourceKey || '').trim().toLowerCase();
    const telegramPostId = Number(leadMediaCandidate?.telegramPostId) || 0;

    if (sourceKey) {
      const exactCluster = list.find((cluster) =>
        Array.isArray(cluster.sourceKeys) &&
        cluster.sourceKeys.some((item) => String(item || '').trim().toLowerCase() === sourceKey)
      );
      if (exactCluster) {
        return exactCluster;
      }
    }

    return list.find((cluster) =>
      Array.isArray(cluster.postIds) && cluster.postIds.includes(telegramPostId)
    );
  }

  _enforceEmojiLimit(text, maxCount = 2) {
    if (!text) {
      return text;
    }

    let seen = 0;
    return text
      .replace(EMOJI_REGEX, (match) => {
        seen += 1;
        return seen <= maxCount ? match : '';
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  _applySourceCustomEmojiMarkup(htmlText, leadMediaCandidate) {
    if (!htmlText || !leadMediaCandidate?.entities || !leadMediaCandidate?.text) {
      return htmlText;
    }

    let entities;
    try {
      entities = JSON.parse(leadMediaCandidate.entities);
    } catch {
      return htmlText;
    }

    const sourceText = String(leadMediaCandidate.text || '');
    const emojiMap = new Map();

    for (const entity of entities) {
      if (!entity || !String(entity.type || '').includes('CustomEmoji') || !entity.documentId) {
        continue;
      }

      const offset = Number(entity.offset) || 0;
      const length = Number(entity.length) || 0;
      const emojiChar = sourceText.slice(offset, offset + length);
      if (!emojiChar || emojiMap.has(emojiChar)) {
        continue;
      }

      emojiMap.set(emojiChar, String(entity.documentId));
    }

    if (emojiMap.size === 0) {
      return htmlText;
    }

    let enriched = htmlText;
    for (const [emojiChar, documentId] of emojiMap.entries()) {
      const escaped = emojiChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      enriched = enriched.replace(
        new RegExp(escaped, 'g'),
        `<tg-emoji emoji-id="${documentId}">${emojiChar}</tg-emoji>`,
      );
    }

    return enriched;
  }
}

module.exports = PostGenerator;
