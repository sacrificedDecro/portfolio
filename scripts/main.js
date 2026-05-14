(function () {
  'use strict';

  const $  = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  let ytPlayer     = null;
  let musicReady   = false;
  let musicStarted = false;

  function initNav() {
    const nav     = $('#nav');
    const links   = $$('.nav__link');
    const targets = $$('section[id]');
    const OFFSET  = 140;

    const onScroll = () => {
      nav.classList.toggle('scrolled', window.scrollY > 28);

      let current = '';
      for (const sec of targets) {
        if (window.scrollY >= sec.offsetTop - OFFSET) current = sec.id;
      }

      for (const link of links) {
        const isActive = link.getAttribute('href') === '#' + current;
        link.classList.toggle('active', isActive);
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function initScrollReveal() {
    const items  = $$('.reveal');
    const groups = $$('.skills__grid, .cards-grid, .hero__content, .contact__inner, .about__panels');

    groups.forEach(grid => {
      const kids = $$('.reveal', grid);
      const slow = grid.classList.contains('hero__content') || grid.classList.contains('contact__inner');
      const step = slow ? 120 : 90;
      kids.forEach((el, i) => {
        el.style.transitionDelay = `${i * step}ms`;
      });
    });

    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      }
    }, { threshold: 0.08, rootMargin: '0px 0px -50px 0px' });

    items.forEach(el => io.observe(el));
  }

  function initSkillFilter() {
    const tags  = $$('.filter-tag');
    const cards = $$('.skill-card');
    if (!tags.length) return;

    tags.forEach(tag => {
      tag.addEventListener('click', () => {
        const want = tag.dataset.filter;

        for (const t of tags) {
          const on = t === tag;
          t.classList.toggle('active', on);
          t.setAttribute('aria-pressed', on ? 'true' : 'false');
        }

        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          const ok = want === 'all' || card.dataset.category === want;
          card.classList.toggle('hidden', !ok);
        }
      });
    });
  }

  function initHeroBadges() {
    const badges = $$('.hero__badges .badge');
    if (!badges.length) return;

    badges.forEach((b, i) => {
      b.style.opacity         = '0';
      b.style.transform       = 'translateY(10px)';
      b.style.transition      = 'opacity 500ms ease, transform 500ms ease';
      b.style.transitionDelay = `${300 + i * 120}ms`;
    });

    requestAnimationFrame(() => requestAnimationFrame(() => {
      badges.forEach(b => {
        b.style.opacity   = '1';
        b.style.transform = 'translateY(0)';
      });
    }));
  }

  function initSmoothScroll() {
    if ('scrollBehavior' in document.documentElement.style) return;

    $$('a[href^="#"]').forEach(a => {
      a.addEventListener('click', e => {
        const target = $(a.getAttribute('href'));
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function initMusicPlayer() {
    const toggle = $('#musicToggle');
    const bars   = $('#musicBars');

    const syncUI = () => {
      if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;
      const playing = ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
      if (bars) bars.classList.toggle('paused', !playing);
      if (toggle) {
        toggle.textContent = playing ? '⏸' : '▶';
        toggle.setAttribute('aria-label', playing ? 'Pause music' : 'Play music');
      }
    };

    window.onYouTubeIframeAPIReady = function () {
      ytPlayer = new YT.Player('yt-player', {
        height: '150',
        width:  '200',
        videoId: '4ITXBijY1N8',
        playerVars: {
          autoplay:       0,
          controls:       0,
          disablekb:      1,
          enablejsapi:    1,
          fs:             0,
          iv_load_policy: 3,
          modestbranding: 1,
          playsinline:    1,
          rel:            0
        },
        events: {
          onReady() {
            musicReady = true;
            ytPlayer.setVolume(55);
          },
          onStateChange(e) {
            if (e.data === YT.PlayerState.ENDED) {
              ytPlayer.seekTo(0);
              ytPlayer.playVideo();
            }
            syncUI();
          }
        }
      });
    };

    document.addEventListener('click', function onFirstClick(e) {
      if (e.target.id === 'musicToggle') return;
      if (!musicReady || musicStarted) return;
      musicStarted = true;
      ytPlayer.playVideo();
      document.removeEventListener('click', onFirstClick);
    });

    if (toggle) {
      toggle.addEventListener('click', () => {
        if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;
        const state = ytPlayer.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
          ytPlayer.pauseVideo();
        } else {
          musicStarted = true;
          ytPlayer.playVideo();
        }
      });
    }
  }

  initNav();
  initScrollReveal();
  initSkillFilter();
  initHeroBadges();
  initSmoothScroll();
  initMusicPlayer();
})();
