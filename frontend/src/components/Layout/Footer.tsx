import React from 'react';

const Footer: React.FC = () => {
  return (
    <footer className="w-full bg-slate-100 py-4">
      <div className="container mx-auto px-4 flex justify-between items-center">
        <p className="text-sm text-slate-700">
          {new Date().getFullYear()} Aviator. All rights reserved.
        </p>
        <div className="space-x-4">
          <a href="/privacy" className="text-sm text-slate-600 hover:text-slate-800">Privacy Policy</a>
          <a href="/terms" className="text-sm text-slate-600 hover:text-slate-800">Terms of Service</a>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
