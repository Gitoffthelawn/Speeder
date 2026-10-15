(() => {
  const frame = document.createElement('iframe');
  frame.src = 'about:blank';
  document.documentElement.append(frame);
  const clean = frame.contentWindow;
  const descriptor = value => ({
    configurable: value.configurable,
    enumerable: value.enumerable,
    writable: value.writable,
    name: value.value.name,
    length: value.value.length,
    text: Function.prototype.toString.call(value.value)
  });
  const current = descriptor(Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow'));
  const pristine = descriptor(Object.getOwnPropertyDescriptor(clean.Element.prototype, 'attachShadow'));
  window.challengeRecords = window.challengeRecords || [];
  window.challengeRecords.push({
    current,
    pristine,
    equal: JSON.stringify(current) === JSON.stringify(pristine),
    ownPushState: Object.hasOwn(history, 'pushState'),
    speederNames: Object.getOwnPropertyNames(window).filter(name => name.toLowerCase().includes('speeder'))
  });
  frame.remove();
})();
