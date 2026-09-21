-- AIMoney Lab seed: 12 researched opportunities, briefs for the top 4,
-- one starter experiment. Scores follow score = 100*(value*confidence*fit)/(effort+1).
-- Only applied to an empty opportunities table (see deploy.sh).
-- Re-runnable: every statement is a no-op when its row already exists, so a
-- second apply changes nothing (the deploy.sh seed guard still skips
-- non-empty tables; these guards only protect against a blind re-apply).

INSERT OR IGNORE INTO opportunities (slug, title, one_liner, category, status, value, effort, confidence, fit, score, est_monthly_low, est_monthly_high, time_to_first_dollar, capital_needed, skills_needed, source, source_url, notes) VALUES
('ai-ugc-ads-service', 'AI UGC video ads for DTC brands', 'Sell AI-generated UGC-style video ads to e-commerce brands on retainer.', 'services', 'researching', 8, 3, 8, 10, 16000, 2000, 8000, '2-4 weeks', '$0-200/mo tools', '["video AI","ad creative","outreach"]', 'seed', 'https://medium.com/@pallav_45297/the-ai-ugc-video-ad-industry-in-2026-the-data-nobody-puts-in-one-place-f2f5a7a503d8', 'Highest fit: the ai-ugc-ad-engine already exists. Demand signal is the strongest in this list (165x search growth, mainstream buyer category).'),
('ai-freelance-outcomes', 'Specialist AI freelancer (outcomes, not outputs)', 'Sell fixed business outcomes (more leads, hours saved) instead of commodity AI content.', 'services', 'backlog', 6, 3, 8, 8, 9600, 1500, 6000, '1-3 weeks', '$0', '["AI tooling","positioning","sales calls"]', 'seed', 'https://medium.com/write-a-catalyst/everyone-started-selling-ai-content-heres-what-pays-instead-4ad5cc2162ce', 'Fastest first dollar on the board. The 44% specialist premium only holds with outcome-based positioning.'),
('ai-chatbot-integration', 'SMB chatbot + lead-capture installs', 'Install AI chat/lead-capture on local business sites for setup + monthly care fee.', 'services', 'backlog', 6, 3, 7, 9, 9450, 1000, 5000, '2-4 weeks', '$0-100/mo', '["chatbots","web basics","local outreach"]', 'seed', 'https://www.shopify.com/ie/blog/ai-side-hustles', 'Response-speed pitch is easy to demo and easy to price against ($10-50k/yr value claims). High fit, low effort.'),
('ai-automation-agency', 'AI automation agency (n8n/Make + AI)', 'Design-build-maintain automations for service businesses.', 'agency', 'backlog', 9, 5, 7, 9, 9450, 3000, 15000, '1-2 months', '$0-300/mo', '["n8n","APIs","sales"]', 'seed', 'https://www.technology.org/2026/04/23/inside-the-productive-io-survey-what-ai-agencies-actually-charge-in-2026/', 'Biggest ceiling in services, but pricing is messier than gurus admit and much guru revenue comes from teaching, not doing.'),
('micro-saas-ai-tool', 'Micro-SaaS: one AI tool, one niche', 'Single-problem AI subscription tool, solo-built, $1k-50k MRR target.', 'saas', 'backlog', 9, 6, 7, 9, 8100, 1000, 20000, '2-4 months', '$0-500', '["coding","niche research","support"]', 'seed', 'https://www.flowjam.com/blog/27-micro-saas-examples-that-actually-print-money-in-2025', 'Best long-term asset. Risk: niches get eaten fast (AI clones in hours) — pick distribution-first ideas.'),
('ai-video-agency-tiktok', 'Short-form AI creative retainers', 'Monthly packs of AI UGC/TikTok/Reels creatives for 3-5 brands.', 'agency', 'backlog', 7, 4, 6, 9, 7560, 2000, 7000, '3-6 weeks', '$0-200/mo', '["video AI","hooks","client mgmt"]', 'seed', 'https://github.com/anil-matcha/ai-creator-academy/blob/HEAD/tracks/01-ai-video-ads-ugc/04-pricing-and-selling-ugc.md', 'Same engine as #1, packaged as recurring creative instead of one-off ads. Anchor to retainer ranges, never hourly.'),
('ai-consulting-retainers', 'Fractional AI officer for SMBs', 'Monthly retainer to run a small company''s AI adoption: tools, workflows, training.', 'services', 'backlog', 8, 4, 6, 7, 6720, 2000, 8000, '1-2 months', '$0', '["AI breadth","workshops","trust"]', 'seed', 'https://www.shopify.com/ie/blog/ai-side-hustles', 'Sells on trust and breadth, not code. Needs 1-2 proof assets (audits, case notes) before outreach.'),
('ai-voice-agents-local', 'AI voice receptionist for local businesses', 'Missed-call textback + AI booking for dentists, salons, trades.', 'services', 'backlog', 8, 5, 6, 8, 6400, 2000, 10000, '1-2 months', '$100-400/mo telco+AI', '["voice AI","telephony","local sales"]', 'seed', 'https://measureu.com/agency-jobs-ai-automation/', 'Clear ROI story (never miss a lead). Effort is in reliability + accent handling, not demos.'),
('digital-products-prompts', 'Prompt packs + AI templates', 'Niche prompt systems and templates sold on Gumroad/own site.', 'products', 'backlog', 4, 2, 6, 7, 5600, 200, 2000, '1-2 weeks', '$0', '["packaging","niche picking"]', 'seed', 'https://www.shopify.com/ie/blog/ai-side-hustles', 'Low ceiling, near-zero effort. Best as a lead magnet for the service offers, not a main bet.'),
('faceless-youtube-ai', 'Faceless AI YouTube channel(s)', 'AI-voiced niche documentaries; ad + affiliate + sponsor revenue.', 'content', 'backlog', 7, 6, 6, 8, 4800, 300, 10000, '3-6 months', '$50-200/mo', '["scripting","voice AI","editing"]', 'seed', 'https://flippa.com/11976410-unique-upportunity-large-ai-youtube-faceless-channel-with-466ksubs-viral-documentaries-378k-annual-revenue-65m-views', 'Verified $15k/mo exits exist, but the median monetized channel clears ~$280/mo and most never monetize. Portfolio approach or skip.'),
('ai-boilerplate-starter', 'AI SaaS boilerplate / starter kit', 'Ship the auth+AI+billing starter you wish existed; sell licenses.', 'products', 'backlog', 5, 4, 5, 9, 4500, 300, 3000, '1-2 months', '$0', '["coding","docs","marketing"]', 'seed', 'https://dodopayments.com/blogs/micro-saas-ideas-2026', 'Crowded shelf; wins on opinionated AI patterns and proof you ship. Good side-bet while building micro-SaaS.'),
('ai-seo-content-sites', 'Programmatic SEO niche sites', 'AI-written niche content sites monetized with affiliates/display.', 'content', 'backlog', 6, 5, 5, 8, 4000, 200, 4000, '3-6 months', '$50-200/mo', '["SEO","content ops"]', 'seed', 'https://medium.com/@millennialnextdoorblog/is-faceless-youtube-automation-still-worth-it-in-2026-case-studies-from-reddit-prove-it-is-1829bcb6b0d1', 'Google volatility is the permanent risk. Treat as traffic asset feeding other offers, not standalone income.');

-- Briefs for the top 4: one guarded INSERT each (no-op on re-apply).
INSERT INTO briefs (opportunity_id, version, summary, what_works, numbers_json, risks, first_steps, sources_json, author)
SELECT (SELECT id FROM opportunities WHERE slug='ai-ugc-ads-service'), 1,
'US search demand for "ai ugc" grew ~165x to 7,300/mo and now triggers a Google AI Overview: buyers already want this. DTC brands pay $3k+ fixed contracts for AI video editors, and Fiverr gigs prove the low-end market clears. With a working ad engine, this is a distribution problem, not a product problem.',
'- Sell creative VOLUME: brands need 10-30 fresh creatives/mo for Meta/TikTok testing
- Lead with spec ads made from their existing product photos (no access needed)
- Price per batch + monthly retainer; never hourly
- Niche down: supplements, beauty, or pet DTC first',
'[{"claim":"US searches for ai ugc grew ~165x (44/mo to 7,300/mo) Jan 2023-Jul 2026","source":"Ahrefs via Medium/Pallav 2026"},{"claim":"$3,000 fixed-price AI video editor contract (DTC supplement, Upwork Aug 2026)","source":"Upwork listing"},{"claim":"Synthesia $4B valuation / ElevenLabs $500M at $11B — avatar+voice stack is funded and stable","source":"TechCrunch Jan/Feb 2026"}]',
'Racing to the bottom on Fiverr pricing; avatar uncanny-valley for beauty niche; Meta creative fatigue means constant new hooks needed.',
'1. Pick 1 niche (supplements). 2. Generate 10 spec ads for 10 real brands from public assets. 3. Cold DM/email with the video attached, not a pitch deck. 4. First reply -> $500 pilot batch -> $1.5-3k retainer.',
'[{"title":"AI UGC Video Ad Industry 2026: data in one place","url":"https://medium.com/@pallav_45297/the-ai-ugc-video-ad-industry-in-2026-the-data-nobody-puts-in-one-place-f2f5a7a503d8"},{"title":"AI UGC pricing and selling guide","url":"https://github.com/anil-matcha/ai-creator-academy/blob/HEAD/tracks/01-ai-video-ads-ugc/04-pricing-and-selling-ugc.md"}]',
'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM briefs b
  JOIN opportunities o ON o.id = b.opportunity_id
  WHERE o.slug = 'ai-ugc-ads-service' AND b.version = 1 AND b.author = 'seed'
);

INSERT INTO briefs (opportunity_id, version, summary, what_works, numbers_json, risks, first_steps, sources_json, author)
SELECT (SELECT id FROM opportunities WHERE slug='ai-freelance-outcomes'), 1,
'The 2026 freelance market split: commodity AI outputs pay less than ever, while specialists selling outcomes earn a 44% hourly premium. The entire game is positioning — fixed-price business results (leads booked, hours saved) instead of deliverables (blogs written, images made).',
'- Productize 2-3 fixed-scope offers with a number attached ("+20 booked calls/mo")
- Show before/after proof, not tool lists
- Start on Upwork for reviews, move winners off-platform fast
- Raise prices every 3rd client until close rate drops under 30%',
'[{"claim":"AI specialists earn a 44% hourly premium over non-AI peers when selling outcomes","source":"Write A Catalyst / Rahul Gaur 2026"},{"claim":"7 side hustles tested over 3 months: 5 failures, 1 winner — positioning decided it","source":"Medium / Andrew Collins 2026"}]',
'Upwork race-to-bottom if you compete on price; scope creep on fixed-price deals; feast/famine without pipeline.',
'1. Write 3 outcome offers with prices. 2. Build 1 demo/proof asset per offer. 3. Send 10 tailored Upwork proposals/day for 2 weeks. 4. Convert first win into a case study, raise price.',
'[{"title":"Everyone Started Selling AI Content. Here is What Pays Instead","url":"https://medium.com/write-a-catalyst/everyone-started-selling-ai-content-heres-what-pays-instead-4ad5cc2162ce"}]',
'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM briefs b
  JOIN opportunities o ON o.id = b.opportunity_id
  WHERE o.slug = 'ai-freelance-outcomes' AND b.version = 1 AND b.author = 'seed'
);

INSERT INTO briefs (opportunity_id, version, summary, what_works, numbers_json, risks, first_steps, sources_json, author)
SELECT (SELECT id FROM opportunities WHERE slug='ai-chatbot-integration'), 1,
'Response speed is the pitch: faster lead response is worth $10-50k/yr to a service business, and McKinsey 2026 puts automation time-savings at 20-30% of manual work. Setup fee + monthly care retainer is the standard package; the tech is now trivial, so this is a local-sales play.',
'- Demo on THEIR website (clone a page, add the bot, record a Loom)
- Charge setup ($500-2k) + care plan ($100-300/mo)
- Bundle: chatbot + missed-call textback + review requests
- Target high-ticket local: dentists, lawyers, contractors, clinics',
'[{"claim":"Faster response adds $10k-50k/yr revenue for service SMBs","source":"Medium / Octacs 2026 pricing guide"},{"claim":"Automation cuts manual-task time 20-30% (McKinsey 2026)","source":"McKinsey via Medium 2026"}]',
'Churn when the owner stops checking leads; chatbot hallucinations need guardrails + human handoff; Wix/Squarespace sites limit integration depth.',
'1. Build 1 demo bot on a cloned local-business page. 2. Record a 90-second Loom of it booking a fake appointment. 3. Walk/call 20 local businesses with the video. 4. First yes -> install weekend, care plan from day 1.',
'[{"title":"Best AI Side Hustles 2026 (Shopify)","url":"https://www.shopify.com/ie/blog/ai-side-hustles"}]',
'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM briefs b
  JOIN opportunities o ON o.id = b.opportunity_id
  WHERE o.slug = 'ai-chatbot-integration' AND b.version = 1 AND b.author = 'seed'
);

INSERT INTO briefs (opportunity_id, version, summary, what_works, numbers_json, risks, first_steps, sources_json, author)
SELECT (SELECT id FROM opportunities WHERE slug='ai-automation-agency'), 1,
'The $10k/mo AI retainer is real but far from universal — Productive.io 2026 survey data shows messy, wide pricing. Transparent operators (e.g. $100k+ earners) often make most of it teaching, not doing. The agency model works, but only with niche positioning and proof, not generic "we do AI automation".',
'- Niche by vertical AND workflow (e.g. "AI intake for law firms"), never generic
- Start with paid audits ($250-500) that convert to builds
- Standardize 3 flagship builds; custom everything does not scale solo
- Retainers for monitoring + iteration, not just ship-and-leave',
'[{"claim":"$10k/mo AI retainers exist but are far from universal; pricing is messy","source":"Productive.io survey via Technology.org 2026"},{"claim":"AI automation agencies report $500k-1M+ revenue/employee vs $150-200k traditional","source":"MeasureU 2026"},{"claim":"Top transparent earner made most of $100k+ from teaching community, not agency work","source":"Medium / Just AI Things (Zubair Trabzada) 2026"}]',
'Guru-saturated positioning ("AI automation agency" means nothing now); long B2B sales cycles; maintenance burden of bespoke n8n spaghetti.',
'1. Pick ONE vertical you can reach. 2. Ship 2 demo automations with Loom walkthroughs. 3. Sell 5 paid audits at $250. 4. Convert 1-2 audits into $2-5k builds + care retainers.',
'[{"title":"What AI Agencies Actually Charge in 2026","url":"https://www.technology.org/2026/04/23/inside-the-productive-io-survey-what-ai-agencies-actually-charge-in-2026/"}]',
'seed'
WHERE NOT EXISTS (
  SELECT 1 FROM briefs b
  JOIN opportunities o ON o.id = b.opportunity_id
  WHERE o.slug = 'ai-automation-agency' AND b.version = 1 AND b.author = 'seed'
);

-- Starter experiment for the top pick (no-op on re-apply).
INSERT INTO experiments (opportunity_id, name, hypothesis, status, budget_cap, spent, metric, target)
SELECT (SELECT id FROM opportunities WHERE slug='ai-ugc-ads-service'),
 'Spec-ad sprint: 10 brands, 10 free ads',
 'If we send 10 DTC supplement brands a finished spec ad each, at least 1 replies and 1 converts to a paid pilot within 14 days.',
 'planned', '$0 + 10 hours', '', 'replies; pilots closed', '>=3 replies; >=1 pilot at >=$500'
WHERE NOT EXISTS (
  SELECT 1 FROM experiments e
  JOIN opportunities o ON o.id = e.opportunity_id
  WHERE o.slug = 'ai-ugc-ads-service' AND e.name = 'Spec-ad sprint: 10 brands, 10 free ads'
);
