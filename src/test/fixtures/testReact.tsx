// @ts-nocheck
import React from "react";

export const Button = (props: { text: string; onClick: () => void }) => {
  return <button onClick={props.onClick}>{props.text}</button>;
};

export function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}

const MemoizedComponent = React.memo(function MemoComponent(props: {
  value: number;
}) {
  return <div>{props.value}</div>;
});

export class ClassComponent extends React.Component<{ name: string }> {
  render() {
    return <div>Hello, {this.props.name}</div>;
  }
}
