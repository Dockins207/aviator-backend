import React from 'react';
import Link from 'next/link';

const Header: React.FC = () => {
  return (
    <header className="w-full bg-gray-100 shadow-md">
      <div className="container mx-auto px-4 py-3 flex justify-between items-center">
        <div className="text-xl font-bold text-slate-700">Aviator</div>
        <nav>
          {/* Add navigation menu items */}
          <ul className="flex space-x-4">
            <li><Link href="/game-dashboard" className="text-slate-600 hover:text-slate-800">Login</Link></li>
            <li><Link href="/game-dashboard" className="text-slate-600 hover:text-slate-800">Register</Link></li>
            {/* Add more navigation links */}
          </ul>
        </nav>
      </div>
    </header>
  );
};

export default Header;
