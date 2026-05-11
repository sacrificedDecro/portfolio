/* ============================================================
   scripts/main.js
   Monochrome Glass Brutalism — Roblox Portfolio
   ============================================================ */

(function () {
  'use strict';

  /* ----------------------------------------------------------
     STICKY NAV — add glass on scroll
     ---------------------------------------------------------- */
  const nav = document.getElementById('nav');

  function handleNavScroll() {
    nav.classList.toggle('scrolled', window.scrollY > 30);
  }

  window.addEventListener('scroll', handleNavScroll, { passive: true });
  handleNavScroll(); // run on load in case page is already scrolled

  /* ----------------------------------------------------------
     ACTIVE NAV LINK — highlight current section
     ---------------------------------------------------------- */
  const sections  = Array.from(document.querySelectorAll('section[id]'));
  const navLinks  = document.querySelectorAll('.nav__link');
  const navOffset = 140; // px from top before a section is "active"

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

  /* ----------------------------------------------------------
     SCROLL REVEAL — IntersectionObserver
     Stagger siblings inside the same grid/container
     ---------------------------------------------------------- */
  const revealEls = document.querySelectorAll('.reveal');

  // Assign stagger delays to cards within the same parent grid
  function assignStaggerDelays() {
    const grids = document.querySelectorAll('.skills__grid, .cards-grid, .hero__content, .contact__inner');

    grids.forEach((grid) => {
      const children = grid.querySelectorAll('.reveal');
      children.forEach((child, i) => {
        // Hero and contact get a gentler, longer stagger
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
          revealObserver.unobserve(entry.target); // fire once
        }
      });
    },
    {
      threshold:  0.08,
      rootMargin: '0px 0px -50px 0px',
    }
  );

  revealEls.forEach((el) => revealObserver.observe(el));

  /* ----------------------------------------------------------
     SKILLS FILTER
     Click a filter tag to show/hide skill cards
     ---------------------------------------------------------- */
  const filterTags = document.querySelectorAll('.filter-tag');
  const skillCards = document.querySelectorAll('.skill-card');

  filterTags.forEach((tag) => {
    tag.addEventListener('click', () => {
      const filter = tag.dataset.filter;

      // Update button states
      filterTags.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-pressed', 'false');
      });
      tag.classList.add('active');
      tag.setAttribute('aria-pressed', 'true');

      // Show / hide cards
      skillCards.forEach((card) => {
        const matches = filter === 'all' || card.dataset.category === filter;
        card.classList.toggle('hidden', !matches);
      });
    });
  });

  /* ----------------------------------------------------------
     HERO BADGES — staggered entrance on load
     ---------------------------------------------------------- */
  const heroBadges = document.querySelectorAll('.hero__badges .badge');
  heroBadges.forEach((badge, i) => {
    badge.style.opacity         = '0';
    badge.style.transform       = 'translateY(10px)';
    badge.style.transition      = 'opacity 0.5s ease, transform 0.5s ease';
    badge.style.transitionDelay = (300 + i * 120) + 'ms';

    // Trigger on next frame so transition fires
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        badge.style.opacity   = '1';
        badge.style.transform = 'translateY(0)';
      });
    });
  });

  /* ----------------------------------------------------------
     SMOOTH SCROLL for nav links (fallback for Safari < 15.4)
     ---------------------------------------------------------- */
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const target = document.querySelector(anchor.getAttribute('href'));
      if (!target) return;

      // Only intercept if CSS scroll-behavior isn't supported
      if (!('scrollBehavior' in document.documentElement.style)) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

})();
