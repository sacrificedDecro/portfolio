(function () {
  'use strict';

  let ytPlayer      = null;
  let musicReady    = false;
  let musicStarted  = false;

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
        rel:            0,
      },
      events: {
        onReady: function () {
          musicReady = true;
          ytPlayer.setVolume(55);
        },
        onStateChange: function (e) {
          if (e.data === YT.PlayerState.ENDED) {
            ytPlayer.seekTo(0);
            ytPlayer.playVideo();
          }
          syncMusicUI();
        },
      },
    });
  };

  function syncMusicUI() {
    const bars = document.getElementById('musicBars');
    const btn  = document.getElementById('musicToggle');
    if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;
    const playing = ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
    if (bars) bars.classList.toggle('paused', !playing);
    if (btn) {
      btn.textContent = playing ? '⏸' : '▶';
      btn.setAttribute('aria-label', playing ? 'Pause music' : 'Play music');
    }
  }

  document.addEventListener('click', function startOnInteraction(e) {
    if (e.target.id === 'musicToggle') return;
    if (!musicReady || musicStarted) return;
    musicStarted = true;
    ytPlayer.playVideo();
    document.removeEventListener('click', startOnInteraction);
  });

  const toggleBtn = document.getElementById('musicToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () {
      if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;
      const state = ytPlayer.getPlayerState();
      if (state === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
      } else {
        if (!musicStarted) musicStarted = true;
        ytPlayer.playVideo();
      }
    });
  }

  const nav = document.getElementById('nav');

  function handleNavScroll() {
    nav.classList.toggle('scrolled', window.scrollY > 30);
  }

  window.addEventListener('scroll', handleNavScroll, { passive: true });
  handleNavScroll();

  const sections  = Array.from(document.querySelectorAll('section[id]'));
  const navLinks  = document.querySelectorAll('.nav__link');
  const navOffset = 140;

  function updateActiveLink() {
    const scrollY = window.scrollY;
    let current   = '';

    sections.forEach((section) => {
      if (scrollY >= section.offsetTop - navOffset) {
        current = section.getAttribute('id');
      }
    });

    navLinks.forEach((link) => {
      link.classList.remove('active');
      if (link.getAttribute('href') === '#' + current) {
        link.classList.add('active');
      }
    });
  }

  window.addEventListener('scroll', updateActiveLink, { passive: true });
  updateActiveLink();

  const revealEls = document.querySelectorAll('.reveal');

  function assignStaggerDelays() {
    const grids = document.querySelectorAll('.skills__grid, .cards-grid, .hero__content, .contact__inner');

    grids.forEach((grid) => {
      const children = grid.querySelectorAll('.reveal');
      children.forEach((child, i) => {
        const isHero    = grid.classList.contains('hero__content');
        const isContact = grid.classList.contains('contact__inner');
        const baseDelay = (isHero || isContact) ? 120 : 90;
        child.style.transitionDelay = (i * baseDelay) + 'ms';
      });
    });
  }

  assignStaggerDelays();

  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target);
        }
      });
    },
    {
      threshold:  0.08,
      rootMargin: '0px 0px -50px 0px',
    }
  );

  revealEls.forEach((el) => revealObserver.observe(el));

  const filterTags = document.querySelectorAll('.filter-tag');
  const skillCards = document.querySelectorAll('.skill-card');

  filterTags.forEach((tag) => {
    tag.addEventListener('click', () => {
      const filter = tag.dataset.filter;

      filterTags.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-pressed', 'false');
      });
      tag.classList.add('active');
      tag.setAttribute('aria-pressed', 'true');

      skillCards.forEach((card) => {
        const matches = filter === 'all' || card.dataset.category === filter;
        card.classList.toggle('hidden', !matches);
      });
    });
  });

  const heroBadges = document.querySelectorAll('.hero__badges .badge');
  heroBadges.forEach((badge, i) => {
    badge.style.opacity         = '0';
    badge.style.transform       = 'translateY(10px)';
    badge.style.transition      = 'opacity 0.5s ease, transform 0.5s ease';
    badge.style.transitionDelay = (300 + i * 120) + 'ms';

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        badge.style.opacity   = '1';
        badge.style.transform = 'translateY(0)';
      });
    });
  });

  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const target = document.querySelector(anchor.getAttribute('href'));
      if (!target) return;

      if (!('scrollBehavior' in document.documentElement.style)) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

})();
