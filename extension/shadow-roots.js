(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow');
  const original = descriptor.value;
  const dispatch = Element.prototype.dispatchEvent;
  const RootEvent = Event;
  Object.defineProperty(Element.prototype, 'attachShadow', {
    ...descriptor,
    value: function attachShadow(options) {
      const root = Reflect.apply(original, this, arguments);
      if (root.mode === 'open') {
        Reflect.apply(dispatch, this, [new RootEvent('light-torrent-shadow-root', { bubbles: true, composed: true })]);
      }
      return root;
    }
  });
})();
